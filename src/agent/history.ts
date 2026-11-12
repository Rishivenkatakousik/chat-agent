/**
 * The earlier messages of the current conversation, as sent to the model.
 *
 * Only the recent part is sent verbatim (older turns are reachable through memory recall).
 * The last few questions are replayed together with the <context> block they had, so the
 * model keeps the evidence behind its own earlier answers.
 */
import type { ResponseInputItem } from "openai/resources/responses/responses";
import type { Message } from "../types.js";

/** Recent messages sent verbatim. */
const HISTORY_MESSAGES = 12;
const HISTORY_CHARS = 16_000;
/** User turns, counted from the newest, whose <context> (with recalled memory) is replayed. */
const REPLAY_CONTEXT_TURNS = 3;
const REPLAY_CONTEXT_CHARS = 24_000;

/** Ids of the messages the model will see verbatim, so recall doesn't repeat them. */
export function recentHistoryIds(history: Message[]): number[] {
  return history.slice(-HISTORY_MESSAGES).map((message) => message.id);
}

/** The recent messages that fit the budget, starting on a user message so the transcript is well-formed. */
function trimHistory(history: Message[]): Message[] {
  const recent = history.slice(-HISTORY_MESSAGES);

  // Drop the oldest messages until the history fits the budget (always keep the last two).
  let totalChars = recent.reduce((sum, message) => sum + message.text.length, 0);
  while (recent.length > 2 && totalChars > HISTORY_CHARS) {
    totalChars -= recent.shift()!.text.length;
  }

  while (recent.length > 0 && recent[0]!.role !== "user") recent.shift();
  return recent;
}

/**
 * Which questions are replayed with their <context>: the newest ones, up to a count and a size
 * budget. Without this, a follow-up shows the model its own earlier claims ("you asked on Tue 10
 * Nov at 19:00") with none of the memory that supported them, and it may wrongly retract them as
 * made up. The identical text also keeps consecutive turns' prefixes the same, which helps prompt
 * caching.
 */
function pickContextsToReplay(messages: Message[]): Set<number> {
  const replay = new Set<number>();
  let remainingChars = REPLAY_CONTEXT_CHARS;

  for (const message of [...messages].reverse()) {
    if (message.role !== "user" || !message.context) continue;
    if (replay.size >= REPLAY_CONTEXT_TURNS || message.context.length > remainingChars) break;
    replay.add(message.id);
    remainingChars -= message.context.length;
  }
  return replay;
}

/** Conversation history as model input items, oldest first. */
export function buildHistoryInput(history: Message[]): ResponseInputItem[] {
  const recent = trimHistory(history);
  const replay = pickContextsToReplay(recent);

  return recent.map((message) => ({
    role: message.role,
    content: replay.has(message.id) ? `${message.context}\n\n${message.text}` : message.text,
  }));
}
