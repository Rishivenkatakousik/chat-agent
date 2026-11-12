// Talk to a running server (npm run dev) from the terminal:
//   npx tsx scripts/chat.ts "your question" [conversationId]
// Prints status lines with timings, the final answer, sources and the new title.

const message = process.argv[2] ?? "What did I ask you on 3 November?";
const conversationId = process.argv[3] ?? null;
const url = `http://localhost:${process.env.PORT ?? 3000}/api/chat`;

const startedAt = performance.now();
/** Seconds since start, right-aligned: "  3.2s". */
const elapsed = () => `${((performance.now() - startedAt) / 1000).toFixed(1).padStart(5)}s`;

interface ChatEvent {
  type: string;
  [key: string]: any;
}

function printEvent(event: ChatEvent): void {
  switch (event.type) {
    case "conversation":
      console.log(`${elapsed()} conversation ${event.id}`);
      break;
    case "status":
      console.log(`${elapsed()} … ${event.text}`);
      break;
    case "done": {
      const { stats } = event;
      const sources = event.sources.map((s: { n: number; url: string }) => `[${s.n}] ${s.url}`).join(" ");
      console.log(
        `${elapsed()} DONE (first token ${stats.firstTokenMs}ms, ${stats.searches} searches, ` +
          `cached ${stats.cachedTokens}/${stats.inputTokens} tokens)\n\n${event.text}\n\nSources: ${sources}`,
      );
      break;
    }
    case "title":
      console.log(`${elapsed()} TITLE: ${event.title}`);
      break;
    case "error":
      console.log(`${elapsed()} ERROR: ${event.message}`);
      break;
  }
}

/** Splits an SSE stream into events and passes each event's JSON data to `onEvent`. */
async function readSseEvents(body: AsyncIterable<Uint8Array>, onEvent: (event: ChatEvent) => void) {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    let end: number;
    while ((end = buffer.indexOf("\n\n")) >= 0) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const dataLine = block.split("\n").find((line) => line.startsWith("data: "));
      if (dataLine) onEvent(JSON.parse(dataLine.slice("data: ".length)));
    }
  }
}

const response = await fetch(url, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    message,
    conversationId,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  }),
});

if (!response.ok || !response.body) {
  console.log("HTTP", response.status, await response.text());
  process.exit(1);
}

await readSseEvents(response.body as unknown as AsyncIterable<Uint8Array>, printEvent);
