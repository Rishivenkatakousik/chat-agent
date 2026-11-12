import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { config } from "./config.js";

/** All timestamps are UTC epoch milliseconds. Windows are half-open: start <= t < end. */
export interface TimeWindow {
  start: number;
  end: number;
}

export type Role = "user" | "assistant";

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
   * For user messages: the exact <context> block (time, resolved dates, recalled memory) the model saw
   * with this question. Replayed in later turns so the model keeps the evidence behind its earlier answers.
   * Loaded only by getMessages(id, { withContext: true }).
   */
  context?: string | null;
}

/** A message returned from a ranked search; lower `rank` is better (FTS5 bm25 convention). */
export interface RankedMessage extends Message {
  rank: number;
}

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

export interface EmbeddingRow {
  id: number;
  conversation_id: string;
  role: Role;
  created_at: number;
  embedding: Float32Array;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS conversations (
  id          TEXT PRIMARY KEY,
  title       TEXT,
  timezone    TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id              INTEGER PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role            TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  text            TEXT NOT NULL,
  sources_json    TEXT NOT NULL DEFAULT '[]',
  context         TEXT,
  embedding       BLOB,
  created_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_conv_time ON messages(conversation_id, created_at);
CREATE INDEX IF NOT EXISTS messages_time ON messages(created_at);

CREATE TABLE IF NOT EXISTS facts (
  id              INTEGER PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  message_id      INTEGER REFERENCES messages(id) ON DELETE CASCADE,
  entity          TEXT NOT NULL,
  attribute       TEXT NOT NULL,
  value           TEXT NOT NULL,
  source_url      TEXT,
  observed_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS facts_message ON facts(message_id);
CREATE INDEX IF NOT EXISTS facts_time ON facts(observed_at);

-- External-content FTS5 indexes, kept in sync by triggers.
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  text, content='messages', content_rowid='id', tokenize='porter unicode61'
);
CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, text) VALUES (new.id, new.text);
END;
CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.id, old.text);
END;
CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE OF text ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.id, old.text);
  INSERT INTO messages_fts(rowid, text) VALUES (new.id, new.text);
END;

CREATE VIRTUAL TABLE IF NOT EXISTS facts_fts USING fts5(
  entity, attribute, value, content='facts', content_rowid='id', tokenize='porter unicode61'
);
CREATE TRIGGER IF NOT EXISTS facts_ai AFTER INSERT ON facts BEGIN
  INSERT INTO facts_fts(rowid, entity, attribute, value) VALUES (new.id, new.entity, new.attribute, new.value);
END;
CREATE TRIGGER IF NOT EXISTS facts_ad AFTER DELETE ON facts BEGIN
  INSERT INTO facts_fts(facts_fts, rowid, entity, attribute, value)
    VALUES ('delete', old.id, old.entity, old.attribute, old.value);
END;
CREATE TRIGGER IF NOT EXISTS facts_au AFTER UPDATE ON facts BEGIN
  INSERT INTO facts_fts(facts_fts, rowid, entity, attribute, value)
    VALUES ('delete', old.id, old.entity, old.attribute, old.value);
  INSERT INTO facts_fts(rowid, entity, attribute, value) VALUES (new.id, new.entity, new.attribute, new.value);
END;
`;

/**
 * Build a safe FTS5 MATCH expression: each term is quoted (so punctuation and
 * keywords like AND/NEAR can't break the syntax) and the terms are OR-ed.
 * Returns null when there is nothing to search for.
 */
export function toFtsQuery(terms: readonly string[]): string | null {
  const quoted = terms
    .map((t) => t.replace(/"/g, "").trim())
    .filter(Boolean)
    .map((t) => `"${t}"`);
  return quoted.length ? quoted.join(" OR ") : null;
}

function toBlob(v: Float32Array): Uint8Array {
  return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
}

function fromBlob(b: Uint8Array): Float32Array {
  // Copy so the vector is 4-byte aligned regardless of how SQLite hands back the buffer.
  const copy = new Uint8Array(b);
  return new Float32Array(copy.buffer, 0, copy.byteLength / 4);
}

type Row = Record<string, unknown>;

function toMessage(r: Row): Message {
  return {
    id: Number(r.id),
    conversation_id: String(r.conversation_id),
    role: r.role as Role,
    text: String(r.text),
    sources: JSON.parse(String(r.sources_json ?? "[]")) as Source[],
    created_at: Number(r.created_at),
    ...(r.context !== undefined ? { context: r.context == null ? null : String(r.context) } : {}),
  };
}

function toRanked(r: Row): RankedMessage {
  return { ...toMessage(r), rank: Number(r.rank) };
}

function toConversation(r: Row): Conversation {
  return {
    id: String(r.id),
    title: r.title == null ? null : String(r.title),
    timezone: String(r.timezone),
    created_at: Number(r.created_at),
    updated_at: Number(r.updated_at),
  };
}

function toFact(r: Row): Fact {
  return {
    id: Number(r.id),
    conversation_id: String(r.conversation_id),
    message_id: r.message_id == null ? null : Number(r.message_id),
    entity: String(r.entity),
    attribute: String(r.attribute),
    value: String(r.value),
    source_url: r.source_url == null ? null : String(r.source_url),
    observed_at: Number(r.observed_at),
  };
}

const MSG_COLS = "m.id, m.conversation_id, m.role, m.text, m.sources_json, m.created_at";

/** SQL fragment + params restricting a time column to an optional window. */
function windowClause(col: string, w?: TimeWindow): { sql: string; params: SQLInputValue[] } {
  return w ? { sql: ` AND ${col} >= ? AND ${col} < ?`, params: [w.start, w.end] } : { sql: "", params: [] };
}

export function openDb(path: string = config.dbPath) {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  db.exec(SCHEMA);
  // Migration for databases created before messages.context existed.
  const cols = db.prepare("PRAGMA table_info(messages)").all() as { name: string }[];
  if (!cols.some((c) => c.name === "context")) db.exec("ALTER TABLE messages ADD COLUMN context TEXT");

  const all = (sql: string, ...params: SQLInputValue[]) => db.prepare(sql).all(...params) as Row[];
  const get = (sql: string, ...params: SQLInputValue[]) => db.prepare(sql).get(...params) as Row | undefined;

  /** Runs fn atomically. Reentrant: a nested call joins the outer transaction. */
  function transaction<T>(fn: () => T): T {
    if (db.isTransaction) return fn();
    db.exec("BEGIN");
    try {
      const out = fn();
      db.exec("COMMIT");
      return out;
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }

  return {
    raw: db,
    close: () => db.close(),
    transaction,

    // ── Conversations ───────────────────────────────────────────────
    createConversation(opts: { timezone: string; title?: string | null; id?: string; createdAt?: number }): Conversation {
      const now = opts.createdAt ?? Date.now();
      const id = opts.id ?? randomUUID();
      db.prepare(
        "INSERT INTO conversations (id, title, timezone, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      ).run(id, opts.title ?? null, opts.timezone, now, now);
      return { id, title: opts.title ?? null, timezone: opts.timezone, created_at: now, updated_at: now };
    },

    getConversation(id: string): Conversation | undefined {
      const r = get("SELECT * FROM conversations WHERE id = ?", id);
      return r && toConversation(r);
    },

    listConversations(limit = 100): Conversation[] {
      return all(
        `SELECT c.*, (SELECT substr(m.text, 1, 80) FROM messages m
                      WHERE m.conversation_id = c.id AND m.role = 'user' ORDER BY m.created_at, m.id LIMIT 1) AS preview
         FROM conversations c ORDER BY c.updated_at DESC LIMIT ?`,
        limit,
      ).map((r) => ({ ...toConversation(r), preview: r.preview == null ? null : String(r.preview) }));
    },

    setTitle(id: string, title: string): void {
      db.prepare("UPDATE conversations SET title = ? WHERE id = ?").run(title, id);
    },

    deleteConversation(id: string): boolean {
      return Number(db.prepare("DELETE FROM conversations WHERE id = ?").run(id).changes) > 0;
    },

    // ── Messages ────────────────────────────────────────────────────
    appendMessage(m: {
      conversationId: string;
      role: Role;
      text: string;
      sources?: Source[];
      createdAt?: number;
    }): Message {
      const createdAt = m.createdAt ?? Date.now();
      const sources = m.sources ?? [];
      return transaction(() => {
        const res = db
          .prepare(
            "INSERT INTO messages (conversation_id, role, text, sources_json, created_at) VALUES (?, ?, ?, ?, ?)",
          )
          .run(m.conversationId, m.role, m.text, JSON.stringify(sources), createdAt);
        db.prepare("UPDATE conversations SET updated_at = MAX(updated_at, ?) WHERE id = ?").run(
          createdAt,
          m.conversationId,
        );
        return {
          id: Number(res.lastInsertRowid),
          conversation_id: m.conversationId,
          role: m.role,
          text: m.text,
          sources,
          created_at: createdAt,
        };
      });
    },

    getMessages(conversationId: string, opts: { withContext?: boolean } = {}): Message[] {
      return all(
        `SELECT ${MSG_COLS}${opts.withContext ? ", m.context" : ""} FROM messages m
         WHERE m.conversation_id = ? ORDER BY m.created_at, m.id`,
        conversationId,
      ).map(toMessage);
    },

    setContext(messageId: number, context: string): void {
      db.prepare("UPDATE messages SET context = ? WHERE id = ?").run(context, messageId);
    },

    getMessagesByIds(ids: readonly number[]): Message[] {
      if (!ids.length) return [];
      const ph = ids.map(() => "?").join(",");
      return all(`SELECT ${MSG_COLS} FROM messages m WHERE m.id IN (${ph}) ORDER BY m.created_at, m.id`, ...ids).map(
        toMessage,
      );
    },

    /** The user/assistant pair a message belongs to: the nearest user message at or before it, plus the next reply. */
    getExchange(messageId: number): Message[] {
      const anchor = get("SELECT conversation_id, role, created_at, id FROM messages WHERE id = ?", messageId);
      if (!anchor) return [];
      const conv = String(anchor.conversation_id);
      const user =
        anchor.role === "user"
          ? anchor
          : get(
              `SELECT id, created_at FROM messages WHERE conversation_id = ? AND role = 'user'
               AND (created_at < ? OR (created_at = ? AND id < ?)) ORDER BY created_at DESC, id DESC LIMIT 1`,
              conv,
              Number(anchor.created_at),
              Number(anchor.created_at),
              Number(anchor.id),
            );
      if (!user) return this.getMessagesByIds([messageId]);
      const reply = get(
        `SELECT id FROM messages WHERE conversation_id = ? AND role = 'assistant'
         AND (created_at > ? OR (created_at = ? AND id > ?)) ORDER BY created_at, id LIMIT 1`,
        conv,
        Number(user.created_at),
        Number(user.created_at),
        Number(user.id),
      );
      return this.getMessagesByIds(reply ? [Number(user.id), Number(reply.id)] : [Number(user.id)]);
    },

    messagesInRange(from: number, to: number, limit = 200): Message[] {
      return all(
        `SELECT ${MSG_COLS} FROM messages m WHERE m.created_at >= ? AND m.created_at < ?
         ORDER BY m.created_at, m.id LIMIT ?`,
        from,
        to,
        limit,
      ).map(toMessage);
    },

    hasEmbeddings(): boolean {
      return get("SELECT 1 AS x FROM messages WHERE embedding IS NOT NULL LIMIT 1") != null;
    },

    /** Total stored messages (the N in keyword rarity). */
    countMessages(): number {
      return Number(get("SELECT count(*) AS n FROM messages")?.n ?? 0);
    },

    /** How many messages match an FTS5 expression (a keyword's document frequency). */
    countMatches(match: string): number {
      return Number(get("SELECT count(*) AS n FROM messages_fts WHERE messages_fts MATCH ?", match)?.n ?? 0);
    },

    /** BM25 full-text search over messages, optionally inside a time window. `match` is an FTS5 expression (see toFtsQuery). */
    searchMessages(match: string, window?: TimeWindow, limit = 20): RankedMessage[] {
      const w = windowClause("m.created_at", window);
      return all(
        `SELECT ${MSG_COLS}, bm25(messages_fts) AS rank
         FROM messages_fts JOIN messages m ON m.id = messages_fts.rowid
         WHERE messages_fts MATCH ?${w.sql}
         ORDER BY rank LIMIT ?`,
        match,
        ...w.params,
        limit,
      ).map(toRanked);
    },

    // ── Embeddings ──────────────────────────────────────────────────
    setEmbedding(messageId: number, embedding: Float32Array): void {
      db.prepare("UPDATE messages SET embedding = ? WHERE id = ?").run(toBlob(embedding), messageId);
    },

    allEmbeddings(window?: TimeWindow): EmbeddingRow[] {
      const w = windowClause("created_at", window);
      return all(
        `SELECT id, conversation_id, role, created_at, embedding FROM messages
         WHERE embedding IS NOT NULL${w.sql}`,
        ...w.params,
      ).map((r) => ({
        id: Number(r.id),
        conversation_id: String(r.conversation_id),
        role: r.role as Role,
        created_at: Number(r.created_at),
        embedding: fromBlob(r.embedding as Uint8Array),
      }));
    },

    /** Messages that still need an embedding (e.g. written before the embedding call finished or failed). */
    messagesMissingEmbedding(limit = 100): Message[] {
      return all(
        `SELECT ${MSG_COLS} FROM messages m WHERE m.embedding IS NULL ORDER BY m.id LIMIT ?`,
        limit,
      ).map(toMessage);
    },

    // ── Facts ───────────────────────────────────────────────────────
    insertFacts(opts: { conversationId: string; messageId: number | null; observedAt?: number; facts: FactInput[] }): number {
      if (!opts.facts.length) return 0;
      const observedAt = opts.observedAt ?? Date.now();
      const stmt = db.prepare(
        `INSERT INTO facts (conversation_id, message_id, entity, attribute, value, source_url, observed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      return transaction(() => {
        for (const f of opts.facts) {
          stmt.run(opts.conversationId, opts.messageId, f.entity, f.attribute, f.value, f.source_url ?? null, observedAt);
        }
        return opts.facts.length;
      });
    },

    factsForMessages(messageIds: readonly number[]): Fact[] {
      if (!messageIds.length) return [];
      const ph = messageIds.map(() => "?").join(",");
      return all(
        `SELECT * FROM facts WHERE message_id IN (${ph}) ORDER BY observed_at, id`,
        ...messageIds,
      ).map(toFact);
    },

    /** BM25 full-text search over facts (entity, attribute, value), optionally inside a time window. */
    searchFacts(match: string, window?: TimeWindow, limit = 30): (Fact & { rank: number })[] {
      const w = windowClause("f.observed_at", window);
      return all(
        `SELECT f.*, bm25(facts_fts) AS rank
         FROM facts_fts JOIN facts f ON f.id = facts_fts.rowid
         WHERE facts_fts MATCH ?${w.sql}
         ORDER BY rank LIMIT ?`,
        match,
        ...w.params,
        limit,
      ).map((r) => ({ ...toFact(r), rank: Number(r.rank) }));
    },
  };
}

export type Db = ReturnType<typeof openDb>;

let shared: Db | undefined;

/** Process-wide database handle at config.dbPath, opened on first use. */
export function getDb(): Db {
  shared ??= openDb();
  return shared;
}
