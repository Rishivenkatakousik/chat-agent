// Talk to a running server (npm run dev) from the terminal:
//   npx tsx scripts/chat.ts "your question" [conversationId]
// Prints status lines with timings, the final answer, sources and the new title.
const message = process.argv[2] ?? "What did I ask you on 3 November?";
const conversationId = process.argv[3] ?? null;
const t0 = performance.now(); const s = () => ((performance.now() - t0) / 1000).toFixed(1).padStart(5) + "s";
const res = await fetch(`http://localhost:${process.env.PORT ?? 3000}/api/chat`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message, conversationId, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }) });
if (!res.ok) { console.log("HTTP", res.status, await res.text()); process.exit(1); }
const dec = new TextDecoder(); let buf = "";
for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
  buf += dec.decode(chunk, { stream: true });
  let i; while ((i = buf.indexOf("\n\n")) >= 0) {
    const block = buf.slice(0, i); buf = buf.slice(i + 2);
    const line = block.split("\n").find((l) => l.startsWith("data: ")); if (!line) continue;
    const e = JSON.parse(line.slice(6));
    if (e.type === "conversation") console.log(`${s()} conversation ${e.id}`);
    else if (e.type === "status") console.log(`${s()} … ${e.text}`);
    else if (e.type === "done") console.log(`${s()} DONE (first token ${e.stats.firstTokenMs}ms, ${e.stats.searches} searches, cached ${e.stats.cachedTokens}/${e.stats.inputTokens} tokens)\n\n${e.text}\n\nSources: ${e.sources.map((x: { n: number; url: string }) => `[${x.n}] ${x.url}`).join(" ")}`);
    else if (e.type === "title") console.log(`${s()} TITLE: ${e.title}`);
    else if (e.type === "error") console.log(`${s()} ERROR: ${e.message}`);
  }
}
