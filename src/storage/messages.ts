/**
 * Reads and writes the `messages` table: every user question and assistant answer, with the
 * answer's cited sources, the question's <context> block, and an embedding vector.
 * Also the search side of memory: date ranges, BM25 full-text search and stored embeddings.
 */
import type { DatabaseSync } from "node:sqlite";
import type { EmbeddingRow, Message, RankedMessage, Role, Source, TimeWindow } from "../types.js";
import {
  nullableString,
  placeholders,
  queryAll,
  queryOne,
  runInTransaction,
  windowClause,
  type Row,
} from "./sql.js";

export interface NewMessage {
  conversationId: string;
  role: Role;
  text: string;
  sources?: Source[];
  createdAt?: number;
}

/** Every column except `context` and `embedding`, which are loaded only when needed. */
const MESSAGE_COLUMNS = "m.id, m.conversation_id, m.role, m.text, m.sources_json, m.created_at";

function toMessage(row: Row): Message {
  const message: Message = {
    id: Number(row.id),
    conversation_id: String(row.conversation_id),
    role: row.role as Role,
    text: String(row.text),
    sources: JSON.parse(String(row.sources_json ?? "[]")) as Source[],
    created_at: Number(row.created_at),
  };
  // Present only when the query selected it, so API responses don't carry the context.
  if (row.context !== undefined) message.context = nullableString(row.context);
  return message;
}

function toRankedMessage(row: Row): RankedMessage {
  return { ...toMessage(row), rank: Number(row.rank) };
}

// Embeddings are stored as raw float32 bytes in a BLOB column.

function vectorToBlob(vector: Float32Array): Uint8Array {
  return new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength);
}

function blobToVector(blob: Uint8Array): Float32Array {
  // Copy so the vector is 4-byte aligned regardless of how SQLite hands back the buffer.
  const copy = new Uint8Array(blob);
  return new Float32Array(copy.buffer, 0, copy.byteLength / 4);
}

export class MessageStore {
  private readonly connection: DatabaseSync;

  constructor(connection: DatabaseSync) {
    this.connection = connection;
  }

  // ── Writing ─────────────────────────────────────────────────────

  /** Stores a message and bumps the conversation's `updated_at`. */
  append(input: NewMessage): Message {
    const createdAt = input.createdAt ?? Date.now();
    const sources = input.sources ?? [];

    return runInTransaction(this.connection, () => {
      const result = this.connection
        .prepare(
          `INSERT INTO messages (conversation_id, role, text, sources_json, created_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(input.conversationId, input.role, input.text, JSON.stringify(sources), createdAt);

      this.connection
        .prepare("UPDATE conversations SET updated_at = MAX(updated_at, ?) WHERE id = ?")
        .run(createdAt, input.conversationId);

      return {
        id: Number(result.lastInsertRowid),
        conversation_id: input.conversationId,
        role: input.role,
        text: input.text,
        sources,
        created_at: createdAt,
      };
    });
  }

  setContext(messageId: number, context: string): void {
    this.connection.prepare("UPDATE messages SET context = ? WHERE id = ?").run(context, messageId);
  }

  // ── Reading ─────────────────────────────────────────────────────

  /** A conversation's messages, oldest first. */
  list(conversationId: string, options: { withContext?: boolean } = {}): Message[] {
    const columns = options.withContext ? `${MESSAGE_COLUMNS}, m.context` : MESSAGE_COLUMNS;
    const rows = queryAll(
      this.connection,
      `SELECT ${columns} FROM messages m
       WHERE m.conversation_id = ?
       ORDER BY m.created_at, m.id`,
      conversationId,
    );
    return rows.map(toMessage);
  }

  getByIds(ids: readonly number[]): Message[] {
    if (ids.length === 0) return [];
    const rows = queryAll(
      this.connection,
      `SELECT ${MESSAGE_COLUMNS} FROM messages m
       WHERE m.id IN (${placeholders(ids.length)})
       ORDER BY m.created_at, m.id`,
      ...ids,
    );
    return rows.map(toMessage);
  }

  /** The question/answer pair a message belongs to: the nearest question at or before it, plus the next reply. */
  getExchange(messageId: number): Message[] {
    const anchor = queryOne(
      this.connection,
      "SELECT id, conversation_id, role, created_at FROM messages WHERE id = ?",
      messageId,
    );
    if (!anchor) return [];

    const conversationId = String(anchor.conversation_id);
    const question =
      anchor.role === "user"
        ? anchor
        : this.findQuestionBefore(conversationId, Number(anchor.created_at), Number(anchor.id));
    if (!question) return this.getByIds([messageId]);

    const questionId = Number(question.id);
    const reply = this.findReplyAfter(conversationId, Number(question.created_at), questionId);
    return this.getByIds(reply ? [questionId, Number(reply.id)] : [questionId]);
  }

  /** Messages created inside the window, oldest first. A window with more than `limit` keeps the newest. */
  listInWindow(window: TimeWindow, limit = 200): Message[] {
    const rows = queryAll(
      this.connection,
      `SELECT ${MESSAGE_COLUMNS} FROM messages m
       WHERE m.created_at >= ? AND m.created_at < ?
       ORDER BY m.created_at DESC, m.id DESC
       LIMIT ?`,
      window.start,
      window.end,
      limit,
    );
    return rows.map(toMessage).reverse();
  }

  /** How many user questions fall inside the window (so recall can say "showing 8 of 30"). */
  countQuestionsInWindow(window: TimeWindow): number {
    const row = queryOne(
      this.connection,
      "SELECT count(*) AS n FROM messages WHERE role = 'user' AND created_at >= ? AND created_at < ?",
      window.start,
      window.end,
    );
    return Number(row?.n ?? 0);
  }

  // ── Full-text search ────────────────────────────────────────────

  /** Total stored messages (the N in keyword rarity). */
  count(): number {
    return Number(queryOne(this.connection, "SELECT count(*) AS n FROM messages")?.n ?? 0);
  }

  /** How many messages match an FTS5 expression (a keyword's document frequency). */
  countMatches(match: string): number {
    const row = queryOne(
      this.connection,
      "SELECT count(*) AS n FROM messages_fts WHERE messages_fts MATCH ?",
      match,
    );
    return Number(row?.n ?? 0);
  }

  /** BM25 full-text search, optionally inside a time window. `match` comes from `toFtsQuery`. */
  search(match: string, window?: TimeWindow, limit = 20): RankedMessage[] {
    const timeFilter = windowClause("m.created_at", window);
    const rows = queryAll(
      this.connection,
      `SELECT ${MESSAGE_COLUMNS}, bm25(messages_fts) AS rank
       FROM messages_fts JOIN messages m ON m.id = messages_fts.rowid
       WHERE messages_fts MATCH ?${timeFilter.sql}
       ORDER BY rank
       LIMIT ?`,
      match,
      ...timeFilter.params,
      limit,
    );
    return rows.map(toRankedMessage);
  }

  // ── Embeddings ──────────────────────────────────────────────────

  setEmbedding(messageId: number, embedding: Float32Array): void {
    this.connection
      .prepare("UPDATE messages SET embedding = ? WHERE id = ?")
      .run(vectorToBlob(embedding), messageId);
  }

  hasEmbeddings(): boolean {
    const row = queryOne(this.connection, "SELECT 1 AS x FROM messages WHERE embedding IS NOT NULL LIMIT 1");
    return row != null;
  }

  /** Every stored embedding. */
  listEmbeddings(): EmbeddingRow[] {
    const rows = queryAll(
      this.connection,
      "SELECT id, conversation_id, role, created_at, embedding FROM messages WHERE embedding IS NOT NULL",
    );
    return rows.map((row) => ({
      id: Number(row.id),
      conversation_id: String(row.conversation_id),
      role: row.role as Role,
      created_at: Number(row.created_at),
      embedding: blobToVector(row.embedding as Uint8Array),
    }));
  }

  /** Messages that still need an embedding (stored before a key was set, or the call failed). */
  listMissingEmbedding(limit = 100): Message[] {
    const rows = queryAll(
      this.connection,
      `SELECT ${MESSAGE_COLUMNS} FROM messages m WHERE m.embedding IS NULL ORDER BY m.id LIMIT ?`,
      limit,
    );
    return rows.map(toMessage);
  }

  // ── Helpers for getExchange ─────────────────────────────────────

  /** The latest user message before (createdAt, id) in the conversation. */
  private findQuestionBefore(conversationId: string, createdAt: number, id: number): Row | undefined {
    return queryOne(
      this.connection,
      `SELECT id, created_at FROM messages
       WHERE conversation_id = ? AND role = 'user'
         AND (created_at < ? OR (created_at = ? AND id < ?))
       ORDER BY created_at DESC, id DESC
       LIMIT 1`,
      conversationId,
      createdAt,
      createdAt,
      id,
    );
  }

  /**
   * The answer to the question at (createdAt, id): the very next message, if it is an assistant
   * message. A question that was never answered (stopped or failed) has no reply, and must not
   * borrow the answer to a later question.
   */
  private findReplyAfter(conversationId: string, createdAt: number, id: number): Row | undefined {
    const next = queryOne(
      this.connection,
      `SELECT id, role FROM messages
       WHERE conversation_id = ?
         AND (created_at > ? OR (created_at = ? AND id > ?))
       ORDER BY created_at, id
       LIMIT 1`,
      conversationId,
      createdAt,
      createdAt,
      id,
    );
    return next?.role === "assistant" ? next : undefined;
  }
}
