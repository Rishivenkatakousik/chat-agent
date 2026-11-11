import type { Db, Message, Source } from "./db.js";
import { resolveTimeRefs, safeTimeZone } from "./agent/time.js";
import { friendlyError, HISTORY_MESSAGES, runTurn, type TurnEvent, type TurnInput, type TurnStats } from "./agent/turn.js";
import { recall } from "./agent/recall.js";
import { embedQuery, type Embedder } from "./agent/embed.js";

/**
 * One chat request end to end: create the conversation if needed, store the
 * user's message, run the agent, store the answer. Transport-agnostic, so the
 * HTTP route stays thin and this can be tested directly.
 */

export type ChatEvent =
  | { type: "conversation"; id: string; created: boolean }
  | Exclude<TurnEvent, { type: "done" }>
  | { type: "done"; messageId: number; text: string; sources: Source[]; stats: TurnStats };

export interface ChatRequest {
  db: Db;
  conversationId?: string | null;
  message: string;
  timezone?: string | null;
  onEvent: (e: ChatEvent) => void;
  signal?: AbortSignal;
  now?: number;
  /** Test seams: fake model/search for runTurn, fake query embedder for recall (null disables embeddings). */
  deps?: TurnInput["deps"] & { embed?: Embedder | null };
}

export class ChatError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409,
  ) {
    super(message);
  }
}

/** Conversations with a turn in flight; a second concurrent message to the same one is rejected. */
const busy = new Set<string>();

export function isBusy(conversationId: string): boolean {
  return busy.has(conversationId);
}

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

  const run = async (): Promise<Message | null> => {
    try {
      const now = req.now ?? Date.now();
      req.onEvent({ type: "conversation", id: conversationId, created });

      const history = db.getMessages(conversationId);
      // Stored first so the question is never lost; the answer is stored only if the run succeeds.
      const question = db.appendMessage({ conversationId, role: "user", text: message, createdAt: now });

      const timeRefs = resolveTimeRefs(message, now, timezone);
      // Recall skips what the model already sees: the recent history sent verbatim, and this question.
      const exclude = new Set([question.id, ...history.slice(-HISTORY_MESSAGES).map((m) => m.id)]);
      const embed = req.deps?.embed === null ? undefined : (req.deps?.embed ?? embedQuery);
      const recalled = await recall({ db, message, timezone, timeRefs, exclude, embed, signal: req.signal });
      const memory = recalled.memory;
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
      return answer;
    } catch (err) {
      if (req.signal?.aborted) {
        console.log(`[chat] ${conversationId}: client disconnected, run aborted`);
        return null;
      }
      console.error(`[chat] ${conversationId}:`, err);
      req.onEvent({ type: "error", message: friendlyError(err) });
      return null;
    } finally {
      busy.delete(conversationId);
    }
  };

  return { conversationId, run };
}
