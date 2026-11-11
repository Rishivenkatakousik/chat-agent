import { pathToFileURL } from "node:url";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { z } from "zod";
import { config, missingKeys } from "./config.js";
import { getDb, type Db } from "./db.js";
import { ChatError, startChat, type ChatRequest } from "./chat.js";

const chatBody = z.object({
  conversationId: z.string().min(1).max(64).nullish(),
  message: z.string().min(1).max(8_000),
  timezone: z.string().max(64).nullish(),
});

/** `opts.deps` swaps in a fake model/search for tests; `opts.requireKeys: false` skips the API-key check. */
export function createApp(db: Db, opts: { deps?: ChatRequest["deps"]; requireKeys?: boolean } = {}) {
  const app = new Hono();

  app.get("/api/health", (c) =>
    c.json({ ok: missingKeys().length === 0, missingKeys: missingKeys(), model: config.chatModel }),
  );

  app.get("/api/conversations", (c) => c.json({ conversations: db.listConversations() }));

  app.get("/api/conversations/:id/messages", (c) => {
    const conversation = db.getConversation(c.req.param("id"));
    if (!conversation) return c.json({ error: "Conversation not found." }, 404);
    return c.json({ conversation, messages: db.getMessages(conversation.id) });
  });

  app.delete("/api/conversations/:id", (c) =>
    db.deleteConversation(c.req.param("id")) ? c.body(null, 204) : c.json({ error: "Conversation not found." }, 404),
  );

  /**
   * Streams one turn as server-sent events:
   *   conversation → status* → text* → sources? → done | error
   * Each event's data is the JSON of the event object.
   */
  app.post("/api/chat", async (c) => {
    const missing = opts.requireKeys === false ? [] : missingKeys();
    if (missing.length) return c.json({ error: `Server is missing ${missing.join(", ")}. Add it to .env and restart.` }, 503);

    const parsed = chatBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "Expected JSON {message, conversationId?, timezone?}." }, 400);

    const controller = new AbortController();
    let send: (e: { type: string }) => void = () => {};

    let chat: ReturnType<typeof startChat>;
    try {
      chat = startChat({
        db,
        conversationId: parsed.data.conversationId,
        message: parsed.data.message,
        timezone: parsed.data.timezone,
        signal: controller.signal,
        deps: opts.deps,
        onEvent: (e) => send(e),
      });
    } catch (err) {
      if (err instanceof ChatError) return c.json({ error: err.message }, err.status);
      throw err;
    }

    return streamSSE(c, async (stream) => {
      // A closed tab or cancelled fetch aborts the model call and any searches in flight.
      stream.onAbort(() => controller.abort());
      // Writes are queued so events keep their order even though the turn emits synchronously.
      let queue = Promise.resolve();
      send = (e) => {
        if (stream.aborted || stream.closed) return;
        queue = queue.then(() => stream.writeSSE({ event: e.type, data: JSON.stringify(e) })).catch(() => {});
      };
      await chat.run();
      await queue;
    });
  });

  // Front end: static files plus the two browser libraries straight from node_modules (no build step).
  app.get("/vendor/marked.js", serveStatic({ path: "./node_modules/marked/lib/marked.esm.js" }));
  app.get("/vendor/purify.js", serveStatic({ path: "./node_modules/dompurify/dist/purify.es.mjs" }));
  app.use("/*", serveStatic({ root: "./public" }));

  app.onError((err, c) => {
    console.error("[server]", err);
    return c.json({ error: "Internal server error." }, 500);
  });

  return app;
}

// Start the server when run directly (tsx src/server.ts), not when imported by tests.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const db = getDb();
  const app = createApp(db);
  const missing = missingKeys();
  if (missing.length) console.warn(`⚠  Missing ${missing.join(", ")}: chat is disabled until you add it to .env.`);

  const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
    console.log(`Minimi running at http://localhost:${info.port}  (model ${config.chatModel}, db ${config.dbPath})`);
  });

  const shutdown = () => {
    server.close();
    db.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
