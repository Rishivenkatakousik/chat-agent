/**
 * Reads and writes the `conversations` table: one row per chat thread (title, timezone, times).
 * Deleting a conversation also deletes its messages and facts (ON DELETE CASCADE).
 */
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Conversation } from "../types.js";
import { nullableString, queryAll, queryOne, type Row } from "./sql.js";

export interface NewConversation {
  timezone: string;
  title?: string | null;
  /** Fixed id, used by the demo seed. A random UUID otherwise. */
  id?: string;
  createdAt?: number;
}

const PREVIEW_CHARS = 80;

function toConversation(row: Row): Conversation {
  return {
    id: String(row.id),
    title: nullableString(row.title),
    timezone: String(row.timezone),
    created_at: Number(row.created_at),
    updated_at: Number(row.updated_at),
  };
}

export class ConversationStore {
  private readonly connection: DatabaseSync;

  constructor(connection: DatabaseSync) {
    this.connection = connection;
  }

  create(options: NewConversation): Conversation {
    const createdAt = options.createdAt ?? Date.now();
    const conversation: Conversation = {
      id: options.id ?? randomUUID(),
      title: options.title ?? null,
      timezone: options.timezone,
      created_at: createdAt,
      updated_at: createdAt,
    };
    this.connection
      .prepare(
        "INSERT INTO conversations (id, title, timezone, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(conversation.id, conversation.title, conversation.timezone, createdAt, createdAt);
    return conversation;
  }

  get(id: string): Conversation | undefined {
    const row = queryOne(this.connection, "SELECT * FROM conversations WHERE id = ?", id);
    return row ? toConversation(row) : undefined;
  }

  /** Most recently updated first, each with the start of its first question as a `preview`. */
  list(limit = 100): Conversation[] {
    const rows = queryAll(
      this.connection,
      `SELECT c.*,
              (SELECT substr(m.text, 1, ${PREVIEW_CHARS}) FROM messages m
               WHERE m.conversation_id = c.id AND m.role = 'user'
               ORDER BY m.created_at, m.id LIMIT 1) AS preview
       FROM conversations c
       ORDER BY c.updated_at DESC
       LIMIT ?`,
      limit,
    );
    return rows.map((row) => ({ ...toConversation(row), preview: nullableString(row.preview) }));
  }

  setTitle(id: string, title: string): void {
    this.connection.prepare("UPDATE conversations SET title = ? WHERE id = ?").run(title, id);
  }

  /**
   * Returns false when there was no such conversation. Also clears every stored <context>: those
   * blocks may quote the deleted conversation (recalled memory), and they only matter for the next
   * few turns of a chat.
   */
  delete(id: string): boolean {
    const result = this.connection.prepare("DELETE FROM conversations WHERE id = ?").run(id);
    const deleted = Number(result.changes) > 0;
    if (deleted) this.connection.exec("UPDATE messages SET context = NULL WHERE context IS NOT NULL");
    return deleted;
  }
}
