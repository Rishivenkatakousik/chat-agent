/**
 * The HTTP app (Hono): API routes, the static web client, and a last-resort error handler.
 * `createApp` only builds the app; `src/main.ts` starts the server. Tests call `app.request()`.
 */
import { Hono } from "hono";
import { serveStatic } from "@hono/node-server/serve-static";
import type { ChatDependencies } from "../chat/chat-service.js";
import type { Database } from "../storage/database.js";
import { registerChatRoute } from "./routes/chat.js";
import { registerConversationRoutes } from "./routes/conversations.js";

export interface AppOptions {
  /** Fake model/search/embeddings, for tests. */
  deps?: ChatDependencies;
  /** `false` skips the API-key check, for tests. */
  requireKeys?: boolean;
}

export function createApp(db: Database, options: AppOptions = {}): Hono {
  const app = new Hono();

  registerConversationRoutes(app, db);
  registerChatRoute(app, db, options);

  // Web client: static files plus the two browser libraries straight from node_modules (no build step).
  app.get("/vendor/marked.js", serveStatic({ path: "./node_modules/marked/lib/marked.esm.js" }));
  app.get("/vendor/purify.js", serveStatic({ path: "./node_modules/dompurify/dist/purify.es.mjs" }));
  app.use("/*", serveStatic({ root: "./public" }));

  app.onError((error, c) => {
    console.error("[server]", error);
    return c.json({ error: "Internal server error." }, 500);
  });

  return app;
}
