/**
 * Entry point (`npm run dev`): opens the database, starts the HTTP server, fills in missing
 * embeddings in the background, and shuts down cleanly on Ctrl+C.
 */
import { serve } from "@hono/node-server";
import { settleBackground } from "./chat/chat-service.js";
import { config, missingKeys } from "./config.js";
import { backfillEmbeddings } from "./memory/enrich.js";
import { createApp } from "./server/app.js";
import { getDatabase } from "./storage/database.js";

/** How long shutdown waits for background fact extraction to finish. */
const SHUTDOWN_GRACE_MS = 5_000;

const db = getDatabase();
const app = createApp(db);

const missing = missingKeys();
if (missing.length > 0) {
  console.warn(`⚠  Missing ${missing.join(", ")}: chat is disabled until you add it to .env.`);
}

const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(
    `Minimi running at http://localhost:${info.port}  (model ${config.chatModel}, db ${config.dbPath})`,
  );
});

// Vectors for messages stored without one (e.g. seeded before a key was set). Off the startup path.
backfillEmbeddings(db).catch((error) => console.warn("[embed] backfill failed:", error));

let stopping = false;

async function shutdown(): Promise<void> {
  if (stopping) process.exit(1); // second Ctrl+C: don't wait
  stopping = true;

  server.close();
  // Let in-flight fact extraction finish (bounded) so it isn't lost.
  const gracePeriod = new Promise((resolve) => setTimeout(resolve, SHUTDOWN_GRACE_MS));
  await Promise.race([settleBackground(), gracePeriod]);
  db.close();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
