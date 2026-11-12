/**
 * POST /api/chat: runs one turn and streams it to the browser as server-sent events:
 *
 *   conversation → status* → text* → sources? → done → title?     (or … → error)
 *
 * Each event's `data` is the JSON of the event object (see `ChatEvent`).
 */
import type { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { ChatError, startChat, type ChatEvent, type StartedChat } from "../../chat/chat-service.js";
import { missingKeys } from "../../config.js";
import type { Database } from "../../storage/database.js";
import type { AppOptions } from "../app.js";

const chatRequestBody = z.object({
  conversationId: z.string().min(1).max(64).nullish(),
  message: z.string().min(1).max(8_000),
  timezone: z.string().max(64).nullish(),
});

export function registerChatRoute(app: Hono, db: Database, options: AppOptions): void {
  app.post("/api/chat", async (c) => {
    const missing = options.requireKeys === false ? [] : missingKeys();
    if (missing.length > 0) {
      return c.json({ error: `Server is missing ${missing.join(", ")}. Add it to .env and restart.` }, 503);
    }

    const body = chatRequestBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) {
      return c.json({ error: "Expected JSON {message, conversationId?, timezone?}." }, 400);
    }

    // Events are produced before the stream exists; `sendEvent` is pointed at the stream below.
    const abortController = new AbortController();
    let sendEvent: (event: ChatEvent) => void = () => {};

    let chat: StartedChat;
    try {
      chat = startChat({
        db,
        conversationId: body.data.conversationId,
        message: body.data.message,
        timezone: body.data.timezone,
        signal: abortController.signal,
        deps: options.deps,
        onEvent: (event) => sendEvent(event),
      });
    } catch (error) {
      if (error instanceof ChatError) return c.json({ error: error.message }, error.status);
      throw error;
    }

    return streamSSE(c, async (stream) => {
      // A closed tab or cancelled fetch aborts the model call and any searches in flight.
      stream.onAbort(() => abortController.abort());

      // Writes are queued so events keep their order even though the turn emits synchronously.
      let writes = Promise.resolve();
      sendEvent = (event) => {
        if (stream.aborted || stream.closed) return;
        writes = writes
          .then(() => stream.writeSSE({ event: event.type, data: JSON.stringify(event) }))
          .catch(() => {});
      };

      await chat.run();
      await writes;
    });
  });
}
