/**
 * Plain JSON routes: server health, and listing / reading / deleting conversations.
 */
import type { Hono } from "hono";
import { config, missingKeys } from "../../config.js";
import type { Database } from "../../storage/database.js";

const NOT_FOUND = { error: "Conversation not found." };

export function registerConversationRoutes(app: Hono, db: Database): void {
  /** Lets the UI warn about missing API keys before the user types anything. */
  app.get("/api/health", (c) => {
    const missing = missingKeys();
    return c.json({ ok: missing.length === 0, missingKeys: missing, model: config.chatModel });
  });

  app.get("/api/conversations", (c) => {
    return c.json({ conversations: db.conversations.list() });
  });

  app.get("/api/conversations/:id/messages", (c) => {
    const conversation = db.conversations.get(c.req.param("id"));
    if (!conversation) return c.json(NOT_FOUND, 404);
    return c.json({ conversation, messages: db.messages.list(conversation.id) });
  });

  app.delete("/api/conversations/:id", (c) => {
    const deleted = db.conversations.delete(c.req.param("id"));
    return deleted ? c.body(null, 204) : c.json(NOT_FOUND, 404);
  });
}
