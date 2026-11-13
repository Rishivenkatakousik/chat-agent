/**
 * One chat request end to end:
 *   validate → claim the conversation → store the question → recall memory → run the agent
 *   → store the answer → background enrichment (facts, title, embeddings).
 *
 * Transport-agnostic: it reports progress through `onEvent`, so the HTTP route stays thin and
 * this can be tested (and benchmarked) directly.
 */
import { runTurn, type AgentDependencies, type TurnEvent, type TurnStats } from "../agent/agent-loop.js";
import { recentHistoryIds } from "../agent/history.js";
import { buildContext, type ContextInput } from "../agent/prompt.js";
import { embedQuery, type Embedder, type EmbedMany } from "../llm/embeddings.js";
import { describeErrorForLog, friendlyError } from "../llm/openai-client.js";
import { enrichExchange, type EnrichResult } from "../memory/enrich.js";
import { recall, type RecallResult } from "../memory/recall.js";
import type { Database } from "../storage/database.js";
import { safeTimeZone } from "../time/format.js";
import { resolveTimeRefs } from "../time/resolve-time-refs.js";
import type { Message, Source } from "../types.js";
import { BackgroundJobs, ConversationLocks } from "./concurrency.js";

// ── Types ───────────────────────────────────────────────────────────

export type ChatEvent =
  | { type: "conversation"; id: string; created: boolean }
  | Exclude<TurnEvent, { type: "done" }>
  | { type: "done"; messageId: number; text: string; sources: Source[]; stats: TurnStats }
  /** Sent after `done`, for a new conversation, once the background job has named it. */
  | { type: "title"; conversationId: string; title: string };

/** Test seams: fake model and search (for the agent), fake embedders (null disables query embedding). */
export interface ChatDependencies extends AgentDependencies {
  embed?: Embedder | null;
  embedMany?: EmbedMany;
}

export interface ChatRequest {
  db: Database;
  conversationId?: string | null;
  message: string;
  timezone?: string | null;
  onEvent: (event: ChatEvent) => void;
  signal?: AbortSignal;
  /** Fixed clock, for tests. */
  now?: number;
  deps?: ChatDependencies;
}

export interface StartedChat {
  conversationId: string;
  /** Runs the turn. Resolves with the stored answer, or null on failure/abort (already reported as an event). */
  run: () => Promise<Message | null>;
}

/** A request that can't start; `status` is the HTTP status to answer with. */
export class ChatError extends Error {
  readonly status: 400 | 404 | 409;

  constructor(message: string, status: 400 | 404 | 409) {
    super(message);
    this.name = "ChatError";
    this.status = status;
  }
}

// ── Module state ────────────────────────────────────────────────────

/** How long the stream stays open after `done`, waiting for a new conversation's title. */
const TITLE_WAIT_MS = 4_000;
/** A turn that runs longer than this (a stalled stream, a hung search) is stopped with an error. */
const TURN_DEADLINE_MS = 120_000;
/** Added to an answer that was stopped or failed midway, so the model and the user know it is incomplete. */
const CUT_OFF_NOTE = "\n\n_(This answer was cut off before it finished.)_";

const locks = new ConversationLocks();
const backgroundJobs = new BackgroundJobs();

/** Waits for background enrichment still running (used by tests and on shutdown). */
export function settleBackground(): Promise<void> {
  return backgroundJobs.settle();
}

// ── Starting a chat ─────────────────────────────────────────────────

/** Everything `runChat` needs once the request has been validated and the conversation claimed. */
interface ClaimedChat {
  request: ChatRequest;
  message: string;
  conversationId: string;
  created: boolean;
  timezone: string;
  release: () => void;
}

/**
 * Validates the request and claims the conversation synchronously (so HTTP can answer with a
 * 4xx before streaming starts), then returns the async run.
 */
export function startChat(request: ChatRequest): StartedChat {
  const { db } = request;
  const message = request.message.trim();
  if (!message) throw new ChatError("Message is empty.", 400);

  const existing = request.conversationId ? db.conversations.get(request.conversationId) : undefined;
  if (request.conversationId && !existing) throw new ChatError("Conversation not found.", 404);
  if (existing && locks.isBusy(existing.id)) {
    throw new ChatError("This conversation is still answering the previous message.", 409);
  }

  const timezone = safeTimeZone(request.timezone ?? existing?.timezone);
  const conversation = existing ?? db.conversations.create({ timezone });
  const chat: ClaimedChat = {
    request,
    message,
    conversationId: conversation.id,
    created: !existing,
    timezone,
    release: locks.claim(conversation.id),
  };
  return { conversationId: conversation.id, run: () => runChat(chat) };
}

// ── Running a chat ──────────────────────────────────────────────────

async function runChat(chat: ClaimedChat): Promise<Message | null> {
  const { request, conversationId } = chat;
  const { db } = request;

  const now = request.now ?? Date.now();
  const startedAt = performance.now();
  /** The answer's timestamp: the question's time plus the time the turn took (also right with a fixed clock). */
  const answerTime = () => now + Math.max(1, Math.round(performance.now() - startedAt));

  const deadline = AbortSignal.timeout(TURN_DEADLINE_MS);
  const signal = request.signal ? AbortSignal.any([request.signal, deadline]) : deadline;
  /** The answer text streamed so far, kept if the turn is stopped or fails midway. */
  let streamed = "";

  try {
    request.onEvent({ type: "conversation", id: conversationId, created: chat.created });

    const history = db.messages.list(conversationId, { withContext: true });
    // Stored first so the question is never lost.
    const question = db.messages.append({ conversationId, role: "user", text: chat.message, createdAt: now });
    const context = await prepareContext(chat, question, history, now);

    const result = await runTurn({
      message: chat.message,
      history,
      context,
      signal,
      deps: request.deps,
      onEvent: (event) => {
        if (event.type === "text") streamed += event.delta;
        // `done` is re-sent below with the stored message id.
        if (event.type !== "done") request.onEvent(event);
      },
    });

    const answer = db.messages.append({
      conversationId,
      role: "assistant",
      text: result.text,
      sources: result.sources,
      createdAt: answerTime(),
    });
    request.onEvent({ type: "done", messageId: answer.id, ...result });
    // The answer is complete: free the conversation before the background work.
    chat.release();

    // Facts, title and embeddings run off the response path; the reply never waits for them.
    const enrichment = backgroundJobs.track(
      enrichExchange(db, question, answer, {
        client: request.deps?.client,
        embedMany: request.deps?.embedMany,
      }),
    );
    await sendTitleWhenReady(chat, enrichment);
    return answer;
  } catch (error) {
    // Keep what the user already read (marked as cut off), so the next turn knows what was said.
    // No facts are extracted from it. The conversation may have been deleted meanwhile.
    if (streamed.trim() && db.conversations.get(conversationId)) {
      const text = streamed.trim() + CUT_OFF_NOTE;
      db.messages.append({ conversationId, role: "assistant", text, createdAt: answerTime() });
    }

    if (request.signal?.aborted) {
      console.log(`[chat] ${conversationId}: client disconnected, run aborted`);
      return null;
    }
    console.error(`[chat] ${conversationId}: ${describeErrorForLog(error)}`);
    const message = deadline.aborted
      ? "This took too long and was stopped. Please try again."
      : friendlyError(error);
    request.onEvent({ type: "error", message });
    return null;
  } finally {
    chat.release();
  }
}

/** Resolves dates, recalls memory, and stores the exact <context> the model will see with this question. */
async function prepareContext(
  chat: ClaimedChat,
  question: Message,
  history: Message[],
  now: number,
): Promise<ContextInput> {
  const { request, message, timezone } = chat;
  const { db, deps } = request;

  const timeRefs = resolveTimeRefs(message, now, timezone);
  // Skip what the model already sees: the recent history sent verbatim, and this question.
  const exclude = new Set([question.id, ...recentHistoryIds(history)]);
  const embed = deps?.embed === null ? undefined : (deps?.embed ?? embedQuery);

  const recalled = await recall({ db, message, timezone, timeRefs, exclude, embed, signal: request.signal });
  logRecall(recalled);

  const context: ContextInput = { now, timezone, timeRefs, memory: recalled.memory };
  // Keep exactly what the model is shown, so later turns can see the evidence behind this answer.
  db.messages.setContext(question.id, buildContext(context));
  return context;
}

function logRecall(recalled: RecallResult): void {
  const { exchanges, facts, notes, stats } = recalled;
  console.log(
    `[recall] ${exchanges.length} exchanges, ${facts.length} facts, ${notes.length} notes ` +
      `(keywords: ${stats.keywords.join(", ") || "-"}; cue: ${stats.cue}; ` +
      `vectors: ${stats.usedEmbeddings}; ${stats.ms}ms)`,
  );
}

/** For an untitled conversation, keeps the stream open briefly so the sidebar can show the new title. */
async function sendTitleWhenReady(chat: ClaimedChat, enrichment: Promise<EnrichResult>): Promise<void> {
  const { request, conversationId } = chat;
  if (request.db.conversations.get(conversationId)?.title || request.signal?.aborted) return;

  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(resolve, TITLE_WAIT_MS, null);
  });
  const enriched = await Promise.race([enrichment, timeout]);
  clearTimeout(timer);

  if (enriched?.title) request.onEvent({ type: "title", conversationId, title: enriched.title });
}
