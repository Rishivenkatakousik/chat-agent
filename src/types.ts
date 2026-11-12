/**
 * Domain types shared across the app (storage, memory, agent, server).
 * Only plain data shapes live here: no logic, no imports.
 *
 * All timestamps are UTC epoch milliseconds.
 */

// ── Time ────────────────────────────────────────────────────────────

/** A time range. Half-open: start <= t < end. */
export interface TimeWindow {
  start: number;
  end: number;
}

export interface LabeledWindow extends TimeWindow {
  /** Human label in the user's timezone, e.g. "Tue 3 Nov 2026". */
  label: string;
}

/** A time phrase found in a user message, resolved to concrete dates. */
export interface TimeRef {
  /** The phrase as written by the user, e.g. "last Tuesday". */
  phrase: string;
  /** Candidate windows, most likely first. More than one means the phrase is ambiguous. */
  windows: LabeledWindow[];
}

// ── Conversations and messages ──────────────────────────────────────

export type Role = "user" | "assistant";

/** A web page cited in an answer. `n` is the citation number shown as [n]. */
export interface Source {
  n: number;
  title: string;
  url: string;
  published?: string;
}

export interface Conversation {
  id: string;
  title: string | null;
  /** Start of the first question; a fallback label while there is no title (e.g. the answer failed). */
  preview?: string | null;
  timezone: string;
  created_at: number;
  updated_at: number;
}

export interface Message {
  id: number;
  conversation_id: string;
  role: Role;
  text: string;
  sources: Source[];
  created_at: number;
  /**
   * For user messages: the exact <context> block (time, resolved dates, recalled memory) the model
   * saw with this question. Replayed in later turns so the model keeps the evidence behind its
   * earlier answers. Loaded only when asked for (`messages.list(id, { withContext: true })`).
   */
  context?: string | null;
}

/** A message returned from a ranked search; lower `rank` is better (FTS5 bm25 convention). */
export interface RankedMessage extends Message {
  rank: number;
}

/** A message's embedding vector, for semantic search. */
export interface EmbeddingRow {
  id: number;
  conversation_id: string;
  role: Role;
  created_at: number;
  embedding: Float32Array;
}

// ── Facts (structured memory extracted from answers) ────────────────

export interface FactInput {
  entity: string;
  attribute: string;
  value: string;
  source_url?: string | null;
}

export interface Fact extends Required<FactInput> {
  id: number;
  conversation_id: string;
  message_id: number | null;
  observed_at: number;
}

export interface RankedFact extends Fact {
  rank: number;
}
