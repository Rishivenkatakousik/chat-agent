/**
 * The SQLite schema: three tables (conversations, messages, facts) plus FTS5 full-text indexes
 * that triggers keep in sync. `createSchema` is idempotent and also migrates older databases.
 */
import type { DatabaseSync } from "node:sqlite";

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

/** Creates any missing tables, indexes and triggers, then applies migrations. */
export function createSchema(connection: DatabaseSync): void {
  connection.exec(SCHEMA);
  addMessageContextColumn(connection);
}

/** Migration for databases created before `messages.context` existed. */
function addMessageContextColumn(connection: DatabaseSync): void {
  const columns = connection.prepare("PRAGMA table_info(messages)").all() as { name: string }[];
  const hasContext = columns.some((column) => column.name === "context");
  if (!hasContext) connection.exec("ALTER TABLE messages ADD COLUMN context TEXT");
}
