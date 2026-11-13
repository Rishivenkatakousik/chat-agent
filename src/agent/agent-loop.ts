/**
 * One user turn with the model:
 *   1. Stream a model round. Text deltas go straight to the UI.
 *   2. Each web_search call starts the moment its arguments are complete, in parallel.
 *   3. Feed the search results back and run another round, until the model answers in text.
 * Emits events for the UI; storing the answer is the caller's job.
 */
import type {
  Response,
  ResponseFunctionToolCall,
  ResponseInputItem,
  ResponseStreamEvent,
} from "openai/resources/responses/responses";
import { APIError } from "openai";
import { config } from "../config.js";
import { getOpenAI, UserFacingError, type ResponsesClient } from "../llm/openai-client.js";
import { SourceRegistry } from "../search/sources.js";
import {
  formatSearchOutput,
  webSearch,
  webSearchTool,
  type SearchOutput,
  type WebSearchFunction,
} from "../search/web-search.js";
import type { Message, Source } from "../types.js";
import { buildHistoryInput } from "./history.js";
import { buildUserInput, SYSTEM_PROMPT, type ContextInput } from "./prompt.js";

// ── Types ───────────────────────────────────────────────────────────

export type TurnEvent =
  | { type: "status"; text: string }
  | { type: "text"; delta: string }
  | { type: "sources"; sources: Source[] }
  | { type: "done"; text: string; sources: Source[]; stats: TurnStats }
  | { type: "error"; message: string };

export interface TurnStats {
  searches: number;
  rounds: number;
  /** ms from start to the first streamed text token. */
  firstTokenMs: number | null;
  totalMs: number;
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  /** Where the time went: phase markers in ms since the turn started (for logs and tuning). */
  timeline: { at: number; what: string }[];
}

/** Test seams: a fake model client and search function. */
export interface AgentDependencies {
  client?: ResponsesClient;
  search?: WebSearchFunction;
}

export interface TurnInput {
  message: string;
  /** Earlier messages in this conversation, oldest first (without the current message). */
  history: Message[];
  context: ContextInput;
  onEvent: (event: TurnEvent) => void;
  signal?: AbortSignal;
  deps?: AgentDependencies;
}

export interface TurnResult {
  text: string;
  sources: Source[];
  stats: TurnStats;
}

// ── Tuning ──────────────────────────────────────────────────────────

/**
 * Model rounds that may call web_search. Each round costs a full model pass (several seconds), so
 * the model is told to search everything in parallel in round 1, with at most one follow-up round;
 * after that it must answer.
 */
const MAX_SEARCH_ROUNDS = 2;
const MAX_ROUNDS = MAX_SEARCH_ROUNDS + 1;
/**
 * A first round this wide (2+ parallel searches) already covers every item (a comparison, a "has it
 * changed" check); a second round would only polish it, so the model answers instead and states what
 * it couldn't confirm. Narrow first rounds keep the follow-up, which multi-step questions need
 * ("who founded the company that…"). So does a wide round in which a search failed (timeout, rate
 * limit): the model gets one more round to try again.
 */
const WIDE_ROUND_SEARCHES = 2;
const PROMPT_CACHE_KEY = "minimi-chat";
const SEARCH_LIMIT_REACHED = "Search limit for this turn reached. Answer with the results you already have.";
const GENERIC_SEARCH_STATUS = "Searching the web…";

// ── Helpers ─────────────────────────────────────────────────────────

/** Records timings and token usage for one turn. */
class TurnTracker {
  readonly stats: TurnStats = {
    searches: 0,
    rounds: 0,
    firstTokenMs: null,
    totalMs: 0,
    inputTokens: 0,
    cachedTokens: 0,
    outputTokens: 0,
    timeline: [],
  };
  private readonly startedAt = performance.now();

  elapsedMs(): number {
    return Math.round(performance.now() - this.startedAt);
  }

  mark(what: string): void {
    this.stats.timeline.push({ at: this.elapsedMs(), what });
  }

  recordFirstToken(): void {
    this.stats.firstTokenMs ??= this.elapsedMs();
  }

  addUsage(usage: Response["usage"]): void {
    if (!usage) return;
    this.stats.inputTokens += usage.input_tokens;
    this.stats.cachedTokens += usage.input_tokens_details?.cached_tokens ?? 0;
    this.stats.outputTokens += usage.output_tokens;
  }
}

/** Parsed function-call arguments, or null when they aren't valid JSON. */
function parseArguments(json: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(json);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** "neon pricing [neon.com]": the query plus any domain filter, for the timeline. */
function describeSearch(args: Record<string, unknown> | null): string {
  const query = typeof args?.query === "string" && args.query ? args.query : GENERIC_SEARCH_STATUS;
  const domains = args?.domains;
  const hasDomains = Array.isArray(domains) && domains.length > 0;
  return hasDomains ? `${query} [${domains.join(", ")}]` : query;
}

function searchStatus(args: Record<string, unknown> | null): string {
  const query = args?.query;
  return typeof query === "string" && query ? `Searching: ${query}` : GENERIC_SEARCH_STATUS;
}

/** What one model round produced. */
interface Round {
  number: number;
  text: string;
  response?: Response;
  /** Search results by function call id, still running while the stream continues. */
  searches: Map<string, Promise<SearchOutput>>;
}

// ── The turn ────────────────────────────────────────────────────────

class TurnRunner {
  private readonly turn: TurnInput;
  private readonly client: ResponsesClient;
  private readonly search: WebSearchFunction;
  private readonly tracker = new TurnTracker();
  /** Starts from the sources of earlier answers, so citation numbers continue across the conversation. */
  private readonly sources: SourceRegistry;
  /** Everything sent to the model: history, this question, then each round's output and search results. */
  private readonly modelInput: ResponseInputItem[];
  /** Text from each round (a preamble before searching, then the answer). */
  private readonly textParts: string[] = [];
  private searchesExhausted = false;
  private wideFirstRound = false;
  private textDeltas = 0;

  constructor(turn: TurnInput) {
    this.turn = turn;
    this.sources = new SourceRegistry(turn.history.flatMap((message) => message.sources));
    this.client = turn.deps?.client ?? getOpenAI();
    this.search = turn.deps?.search ?? webSearch;
    this.modelInput = [
      ...buildHistoryInput(turn.history),
      { role: "user", content: buildUserInput(turn.message, turn.context) },
    ];
  }

  async run(): Promise<TurnResult> {
    for (let roundIndex = 0; roundIndex < MAX_ROUNDS; roundIndex++) {
      this.tracker.stats.rounds = roundIndex + 1;
      const toolsAllowed = !this.searchesExhausted && !this.wideFirstRound && roundIndex < MAX_SEARCH_ROUNDS;

      const round = await this.runRoundWithRetry(roundIndex + 1, toolsAllowed);
      if (round.text) this.textParts.push(round.text);

      if (round.searches.size === 0) {
        this.assertAnswered(round.response!);
        break;
      }
      await this.feedSearchResults(round);
    }
    return this.finish();
  }

  /**
   * Runs a round, and once more if it failed before streaming any text (a 5xx, a dropped stream).
   * By round 2 the searches are already paid for, so giving up on the first hiccup wastes the turn.
   * Client errors (bad key, unknown model, rate limit after the SDK's own retries) are not retried.
   */
  private async runRoundWithRetry(number: number, toolsAllowed: boolean): Promise<Round> {
    const deltasBefore = this.textDeltas;
    try {
      return await this.runRound(number, toolsAllowed);
    } catch (error) {
      const isClientError = error instanceof APIError && error.status !== undefined && error.status < 500;
      const nothingShown = this.textDeltas === deltasBefore;
      if (this.turn.signal?.aborted || isClientError || !nothingShown) throw error;

      this.tracker.mark(`round ${number} failed, retrying once`);
      return this.runRound(number, toolsAllowed);
    }
  }

  /** Streams one model round to the end and returns what it produced. */
  private async runRound(number: number, toolsAllowed: boolean): Promise<Round> {
    this.tracker.mark(`round ${number} request`);
    const stream = await this.client.responses.create(
      {
        model: config.chatModel,
        instructions: SYSTEM_PROMPT,
        input: this.modelInput,
        tools: [webSearchTool],
        tool_choice: toolsAllowed ? "auto" : "none",
        parallel_tool_calls: true,
        reasoning: { effort: config.reasoningEffort },
        // Stateless: the turn's items are resent each round, so reasoning must come back encrypted.
        store: false,
        include: ["reasoning.encrypted_content"],
        prompt_cache_key: PROMPT_CACHE_KEY,
        stream: true,
      },
      { signal: this.turn.signal },
    );

    const round: Round = { number, text: "", searches: new Map() };
    let sawOutput = false;
    for await (const event of stream as AsyncIterable<ResponseStreamEvent>) {
      const isOutput =
        event.type === "response.output_item.done" || event.type === "response.output_text.delta";
      if (isOutput && !sawOutput) {
        sawOutput = true;
        this.tracker.mark(`round ${number} first output`);
      }
      this.handleStreamEvent(event, round);
    }

    if (!round.response) throw new UserFacingError("The model stream ended unexpectedly.");
    const usage = round.response.usage;
    this.tracker.mark(
      `round ${number} complete (${usage?.input_tokens ?? "?"} in / ${usage?.output_tokens ?? "?"} out)`,
    );
    this.tracker.addUsage(usage);
    return round;
  }

  private handleStreamEvent(event: ResponseStreamEvent, round: Round): void {
    switch (event.type) {
      case "response.output_text.delta":
        this.emitText(event.delta, round);
        break;
      case "response.output_item.done":
        if (event.item.type === "function_call") {
          const call = event.item as ResponseFunctionToolCall;
          round.searches.set(call.call_id, this.startSearch(call));
        }
        break;
      case "response.completed":
      case "response.incomplete":
        round.response = event.response;
        break;
      case "response.failed":
        throw new UserFacingError(event.response.error?.message ?? "The model failed to respond.");
      case "error":
        throw new UserFacingError(event.message);
    }
  }

  private emitText(delta: string, round: Round): void {
    this.tracker.recordFirstToken();
    this.textDeltas++;
    // Separate this round's text from an earlier round's (e.g. a preamble before searching).
    const isFirstDeltaAfterEarlierText = round.text === "" && this.textParts.length > 0;
    round.text += delta;
    this.turn.onEvent({ type: "text", delta: isFirstDeltaAfterEarlierText ? `\n\n${delta}` : delta });
  }

  /** Starts one tool call right away; the round collects its result later. */
  private startSearch(call: ResponseFunctionToolCall): Promise<SearchOutput> {
    if (this.tracker.stats.searches >= config.maxSearchesPerTurn) {
      this.searchesExhausted = true;
      return Promise.resolve({ error: SEARCH_LIMIT_REACHED });
    }

    this.tracker.stats.searches++;
    const args = parseArguments(call.arguments);
    this.turn.onEvent({ type: "status", text: searchStatus(args) });

    if (call.name !== "web_search") return Promise.resolve({ error: `Unknown tool ${call.name}` });

    const startedAt = performance.now();
    return this.search(args, this.sources).then((output) => {
      const ms = Math.round(performance.now() - startedAt);
      const failed = "error" in output ? " (error)" : "";
      this.tracker.mark(`search done in ${ms}ms: ${describeSearch(args)}${failed}`);
      return output;
    });
  }

  /** Waits for the round's searches, then appends the round's output and the results to the model input. */
  private async feedSearchResults(round: Round): Promise<void> {
    // Carry this round's output (reasoning, any text, function calls) forward, then the results.
    this.modelInput.push(...(round.response!.output as ResponseInputItem[]));
    const results = await Promise.all(
      [...round.searches].map(async ([callId, pending]) => ({ callId, output: await pending })),
    );

    if (this.tracker.stats.searches >= config.maxSearchesPerTurn) this.searchesExhausted = true;
    const anyFailed = results.some(({ output }) => "error" in output);
    if (round.number === 1 && round.searches.size >= WIDE_ROUND_SEARCHES && !anyFailed) {
      this.wideFirstRound = true;
    }

    for (const { callId, output } of results) {
      this.modelInput.push({
        type: "function_call_output",
        call_id: callId,
        output: formatSearchOutput(output),
      });
    }

    const found = this.sources.foundThisTurn;
    const status =
      found > 0 ? `Reading ${found} sources…` : "Search returned nothing usable; answering with what I have…";
    this.turn.onEvent({ type: "status", text: status });
  }

  /** A round without tool calls is the final one; it must have produced some text. */
  private assertAnswered(response: Response): void {
    if (response.status === "incomplete" && this.textParts.length === 0) {
      const reason = response.incomplete_details?.reason ?? "unknown reason";
      throw new UserFacingError(`The model stopped early (${reason}).`);
    }
  }

  private finish(): TurnResult {
    const text = this.textParts.join("\n\n").trim();
    if (!text) throw new UserFacingError("The model returned an empty answer.");

    const cited = this.sources.cited(text);
    const stats = this.tracker.stats;
    stats.totalMs = this.tracker.elapsedMs();

    if (cited.length > 0) this.turn.onEvent({ type: "sources", sources: cited });
    this.turn.onEvent({ type: "done", text, sources: cited, stats });
    return { text, sources: cited, stats };
  }
}

/** Runs one turn: model rounds and searches until the model answers in text. */
export function runTurn(turn: TurnInput): Promise<TurnResult> {
  return new TurnRunner(turn).run();
}
