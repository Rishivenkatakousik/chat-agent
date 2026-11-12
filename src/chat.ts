import type { Db, Message, Source } from "./db.js";
import { resolveTimeRefs, safeTimeZone } from "./agent/time.js";
import { friendlyError, HISTORY_MESSAGES, runTurn, type TurnEvent, type TurnInput, type TurnStats } from "./agent/turn.js";
import { recall } from "./agent/recall.js";
import { buildContext } from "./agent/prompt.js";
import { embedQuery, type Embedder } from "./agent/embed.js";
import { enrichExchange, type EnrichDeps } from "./agent/extract.js";

/**
 * One chat request end to end: create the conversation if needed, store the
 * user's message, run the agent, store the answer. Transport-agnostic, so the
 * HTTP route stays thin and this can be tested directly.
 */

export type ChatEvent =
  | { type: "conversation"; id: string; created: boolean }
  | Exclude<TurnEvent, { type: "done" }>
  | { type: "done"; messageId: number; text: string; sources: Source[]; stats: TurnStats }
  /** Sent after done, for a new conversation, once the background job has named it. */
  | { type: "title"; conversationId: string; title: string };

export interface ChatRequest {
  db: Db;
  conversationId?: string | null;
  message: string;
  timezone?: string | null;
  onEvent: (e: ChatEvent) => void;
  signal?: AbortSignal;
  now?: number;
  /** Test seams: fake model/search for runTurn, fake query embedder for recall (null disables embeddings). */
  deps?: TurnInput["deps"] & { embed?: Embedder | null; embedMany?: EnrichDeps["embedMany"] };
}

export class ChatError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409,
  ) {
    super(message);
  }
}

/** One-line log form of an error: message plus the API request id, never headers or cookies. */
function describeError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const e = err as Error & { status?: number; requestID?: string };
  return [e.status && `HTTP ${e.status}`, e.message, e.requestID && `(request ${e.requestID})`].filter(Boolean).join(" ");
}

/** Conversations with a turn in flight; a second concurrent message to the same one is rejected. */
const busy = new Set<string>();

/** Background enrichment jobs still running (awaited by tests and on shutdown). */
const background = new Set<Promise<unknown>>();
export async function settleBackground(): Promise<void> {
  while (background.size) await Promise.allSettled([...background]);
}

/** How long the stream stays open after `done` waiting for a new conversation's title. */
const TITLE_WAIT_MS = 4_000;

/**
 * Validates and claims the conversation synchronously (so HTTP can answer 4xx
 * before streaming starts), then returns the async run.
 */
export function startChat(req: ChatRequest): { conversationId: string; run: () => Promise<Message | null> } {
  const { db } = req;
  const message = req.message.trim();
  if (!message) throw new ChatError("Message is empty.", 400);

  let conv = req.conversationId ? db.getConversation(req.conversationId) : undefined;
  if (req.conversationId && !conv) throw new ChatError("Conversation not found.", 404);
  if (conv && busy.has(conv.id)) throw new ChatError("This conversation is still answering the previous message.", 409);

  const timezone = safeTimeZone(req.timezone ?? conv?.timezone);
  const created = !conv;
  conv ??= db.createConversation({ timezone });
  const conversationId = conv.id;
  busy.add(conversationId);

  // Released once, either when the answer is done or when the run ends, never twice.
  let released = false;
  const release = () => {
    if (!released) busy.delete(conversationId);
    released = true;
  };

  const run = async (): Promise<Message | null> => {
    try {
      const now = req.now ?? Date.now();
      req.onEvent({ type: "conversation", id: conversationId, created });

      const history = db.getMessages(conversationId, { withContext: true });
      // Stored first so the question is never lost; the answer is stored only if the run succeeds.
      const question = db.appendMessage({ conversationId, role: "user", text: message, createdAt: now });

      const timeRefs = resolveTimeRefs(message, now, timezone);
      // Recall skips what the model already sees: the recent history sent verbatim, and this question.
      const exclude = new Set([question.id, ...history.slice(-HISTORY_MESSAGES).map((m) => m.id)]);
      const embed = req.deps?.embed === null ? undefined : (req.deps?.embed ?? embedQuery);
      const recalled = await recall({ db, message, timezone, timeRefs, exclude, embed, signal: req.signal });
      const memory = recalled.memory;
      // Keep exactly what the model is shown, so later turns can see the evidence behind this answer.
      db.setContext(question.id, buildContext({ now, timezone, timeRefs, memory }));
      console.log(
        `[recall] ${recalled.exchanges.length} exchanges, ${recalled.facts.length} facts, ${recalled.notes.length} notes ` +
          `(keywords: ${recalled.stats.keywords.join(", ") || "-"}; cue: ${recalled.stats.cue}; vectors: ${recalled.stats.usedEmbeddings}; ${recalled.stats.ms}ms)`,
      );

      const result = await runTurn({
        message,
        history,
        context: { now, timezone, timeRefs, memory },
        signal: req.signal,
        deps: req.deps,
        onEvent: (e) => {
          if (e.type !== "done") req.onEvent(e);
        },
      });

      const answer = db.appendMessage({
        conversationId,
        role: "assistant",
        text: result.text,
        sources: result.sources,
        // Never earlier than the question, even if the clock was faked by a test.
        createdAt: Math.max(Date.now(), now + 1),
      });
      req.onEvent({ type: "done", messageId: answer.id, text: result.text, sources: result.sources, stats: result.stats });
      // The answer is complete: free the conversation before the background work.
      release();

      // Facts, title and embeddings run off the response path and are never awaited by the reply.
      const job = enrichExchange(db, question, answer, { client: req.deps?.client, embedMany: req.deps?.embedMany });
      background.add(job);
      void job.finally(() => background.delete(job));

      // For an untitled conversation, keep the stream open briefly so the sidebar can show the new title.
      if (!db.getConversation(conversationId)?.title && !req.signal?.aborted) {
        let timer: NodeJS.Timeout | undefined;
        const timeout = new Promise<null>((resolve) => (timer = setTimeout(resolve, TITLE_WAIT_MS, null)));
        const enriched = await Promise.race([job, timeout]);
        clearTimeout(timer);
        if (enriched?.title) req.onEvent({ type: "title", conversationId, title: enriched.title });
      }
      return answer;
    } catch (err) {
      if (req.signal?.aborted) {
        console.log(`[chat] ${conversationId}: client disconnected, run aborted`);
        return null;
      }
      console.error(`[chat] ${conversationId}: ${describeError(err)}`);
      req.onEvent({ type: "error", message: friendlyError(err) });
      return null;
    } finally {
      release();
    }
  };

  return { conversationId, run };
}
