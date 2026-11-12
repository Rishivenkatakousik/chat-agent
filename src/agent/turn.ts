import OpenAI, { APIError, APIUserAbortError } from "openai";
import type {
  Response,
  ResponseFunctionToolCall,
  ResponseInputItem,
  ResponseStreamEvent,
} from "openai/resources/responses/responses";
import { config } from "../config.js";
import type { Message, Source } from "../db.js";
import { buildUserInput, SYSTEM_PROMPT, type ContextInput } from "./prompt.js";
import { formatSearchOutput, SourceRegistry, webSearch, webSearchTool, type SearchOutput } from "./search.js";

/**
 * One user turn: stream the model, run web_search calls as soon as each call's
 * arguments are complete (in parallel), feed results back, repeat until the
 * model answers in text. Emits events for the UI; persistence is the caller's job.
 */

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

export interface TurnInput {
  message: string;
  /** Earlier messages in this conversation, oldest first (without the current message). */
  history: Message[];
  context: ContextInput;
  onEvent: (e: TurnEvent) => void;
  signal?: AbortSignal;
  /** Test seams: a fake model client and search function. */
  deps?: { client?: Pick<OpenAI, "responses">; search?: typeof webSearch };
}

export interface TurnResult {
  text: string;
  sources: Source[];
  stats: TurnStats;
}

/**
 * Model rounds that may call web_search. Each round costs a full model pass (several seconds), so the
 * model is told to search everything in parallel in round 1, with at most one follow-up round; after
 * that it must answer.
 */
const MAX_SEARCH_ROUNDS = 2;
/**
 * A first round this wide (2+ parallel searches) already covers every item (a comparison, a "has it changed" check); a second
 * round would only polish it, so the model answers instead and states what it couldn't confirm.
 * Narrow first rounds keep the follow-up, which multi-step questions need ("who founded the company that…").
 */
const WIDE_ROUND = 2;
const MAX_ROUNDS = MAX_SEARCH_ROUNDS + 1;
/** Recent conversation kept verbatim; older turns are reachable through memory recall. */
export const HISTORY_MESSAGES = 12;
const HISTORY_CHARS = 16_000;

let client: OpenAI | undefined;
export function openai(): OpenAI {
  client ??= new OpenAI({ apiKey: config.openaiApiKey, maxRetries: 2, timeout: 90_000 });
  return client;
}

function historyItems(history: Message[]): ResponseInputItem[] {
  const recent = history.slice(-HISTORY_MESSAGES);
  // Drop the oldest messages until the history fits the budget.
  let total = recent.reduce((n, m) => n + m.text.length, 0);
  while (recent.length > 2 && total > HISTORY_CHARS) total -= recent.shift()!.text.length;
  // Start on a user message so the transcript is well-formed.
  while (recent.length && recent[0]!.role !== "user") recent.shift();
  return recent.map((m) => ({ role: m.role, content: m.text }));
}

/** User-facing message for a failure; details go to the server log. */
export function friendlyError(err: unknown): string {
  if (err instanceof APIUserAbortError) return "Request cancelled.";
  if (err instanceof APIError) {
    if (err.status === 401) return "The OpenAI API key was rejected. Check OPENAI_API_KEY in .env.";
    if (err.status === 404) return `The model "${config.chatModel}" is not available to this API key. Set OPENAI_MODEL in .env.`;
    if (err.status === 429) return "OpenAI rate limit or quota reached. Wait a moment and try again.";
    if (err.status && err.status >= 500) return "OpenAI is having trouble right now. Please try again.";
    return `OpenAI error: ${err.message}`;
  }
  return err instanceof Error ? err.message : String(err);
}

function searchStatus(args: string): string {
  try {
    const { query } = JSON.parse(args) as { query?: string };
    if (query) return `Searching: ${query}`;
  } catch {
    /* fall through */
  }
  return "Searching the web…";
}

export async function runTurn({ message, history, context, onEvent, signal, deps }: TurnInput): Promise<TurnResult> {
  const t0 = performance.now();
  const llm = deps?.client ?? openai();
  const search = deps?.search ?? webSearch;
  const sources = new SourceRegistry();
  const stats: TurnStats = {
    searches: 0,
    rounds: 0,
    firstTokenMs: null,
    totalMs: 0,
    inputTokens: 0,
    cachedTokens: 0,
    outputTokens: 0,
    timeline: [],
  };
  const mark = (what: string) => stats.timeline.push({ at: Math.round(performance.now() - t0), what });

  const input: ResponseInputItem[] = [...historyItems(history), { role: "user", content: buildUserInput(message, context) }];
  const textParts: string[] = [];
  let searchesExhausted = false;
  let wideFirstRound = false;

  for (let round = 0; round < MAX_ROUNDS; round++) {
    stats.rounds = round + 1;
    const toolsAllowed = !searchesExhausted && !wideFirstRound && round < MAX_SEARCH_ROUNDS;
    mark(`round ${round + 1} request`);
    let firstOutput = true;

    const stream = await llm.responses.create(
      {
        model: config.chatModel,
        instructions: SYSTEM_PROMPT,
        input,
        tools: [webSearchTool],
        tool_choice: toolsAllowed ? "auto" : "none",
        parallel_tool_calls: true,
        reasoning: { effort: config.reasoningEffort },
        // Stateless: we resend the turn's items each round, so reasoning must come back encrypted.
        store: false,
        include: ["reasoning.encrypted_content"],
        prompt_cache_key: "minimi-chat",
        stream: true,
      },
      { signal },
    );

    // Searches start the moment each call's arguments are complete, not after the stream ends.
    const pending = new Map<string, Promise<SearchOutput>>();
    let roundText = "";
    let completed: Response | undefined;

    for await (const ev of stream as AsyncIterable<ResponseStreamEvent>) {
      if (firstOutput && (ev.type === "response.output_item.done" || ev.type === "response.output_text.delta")) {
        firstOutput = false;
        mark(`round ${round + 1} first output`);
      }
      switch (ev.type) {
        case "response.output_text.delta": {
          if (stats.firstTokenMs == null) stats.firstTokenMs = Math.round(performance.now() - t0);
          // Separate text from an earlier round (e.g. a preamble before searching) from this round's text.
          const delta = !roundText && textParts.length ? `\n\n${ev.delta}` : ev.delta;
          roundText += ev.delta;
          onEvent({ type: "text", delta });
          break;
        }
        case "response.output_item.done": {
          const item = ev.item;
          if (item.type !== "function_call") break;
          const call = item as ResponseFunctionToolCall;
          if (stats.searches >= config.maxSearchesPerTurn) {
            searchesExhausted = true;
            pending.set(call.call_id, Promise.resolve({ error: "Search limit for this turn reached. Answer with the results you already have." }));
            break;
          }
          stats.searches++;
          onEvent({ type: "status", text: searchStatus(call.arguments) });
          let args: unknown;
          try {
            args = JSON.parse(call.arguments);
          } catch {
            args = null;
          }
          const started = performance.now();
          const domains = (args as { domains?: unknown } | null)?.domains;
          const label = `${searchStatus(call.arguments).replace(/^Searching: /, "")}${Array.isArray(domains) && domains.length ? ` [${domains.join(", ")}]` : ""}`;
          const job = call.name === "web_search" ? search(args, sources) : Promise.resolve({ error: `Unknown tool ${call.name}` });
          pending.set(
            call.call_id,
            job.then((out) => {
              mark(`search done in ${Math.round(performance.now() - started)}ms: ${label}${"error" in out ? " (error)" : ""}`);
              return out;
            }),
          );
          break;
        }
        case "response.completed":
        case "response.incomplete":
          completed = ev.response;
          break;
        case "response.failed":
          throw new Error(ev.response.error?.message ?? "The model failed to respond.");
        case "error":
          throw new Error(ev.message);
      }
    }

    if (!completed) throw new Error("The model stream ended unexpectedly.");
    mark(`round ${round + 1} complete (${completed.usage?.input_tokens ?? "?"} in / ${completed.usage?.output_tokens ?? "?"} out)`);
    const u = completed.usage;
    if (u) {
      stats.inputTokens += u.input_tokens;
      stats.cachedTokens += u.input_tokens_details?.cached_tokens ?? 0;
      stats.outputTokens += u.output_tokens;
    }
    if (roundText) textParts.push(roundText);

    if (!pending.size) {
      if (completed.status === "incomplete" && !textParts.length) {
        throw new Error(`The model stopped early (${completed.incomplete_details?.reason ?? "unknown reason"}).`);
      }
      break;
    }

    // Carry this round's output (reasoning, any text, function calls) forward, then the results.
    input.push(...(completed.output as ResponseInputItem[]));
    const results = await Promise.all(
      [...pending].map(async ([callId, p]) => ({ callId, out: await p })),
    );
    if (stats.searches >= config.maxSearchesPerTurn) searchesExhausted = true;
    if (round === 0 && pending.size >= WIDE_ROUND) wideFirstRound = true;
    for (const { callId, out } of results) {
      input.push({ type: "function_call_output", call_id: callId, output: formatSearchOutput(out) });
    }
    const found = sources.list().length;
    onEvent({ type: "status", text: found ? `Reading ${found} sources…` : "Search returned nothing usable; answering with what I have…" });
  }

  const text = textParts.join("\n\n").trim();
  if (!text) throw new Error("The model returned an empty answer.");

  const cited = sources.cited(text);
  stats.totalMs = Math.round(performance.now() - t0);
  if (cited.length) onEvent({ type: "sources", sources: cited });
  onEvent({ type: "done", text, sources: cited, stats });
  return { text, sources: cited, stats };
}
