// Manual check of the web_search tool: `npx tsx scripts/try-search.ts ["query"] [news] [YYYY-MM-DD]`
import { SourceRegistry, webSearch, webSearchTool } from "../src/agent/search.js";

const [query = "Neon Postgres pricing", topic, startDate] = process.argv.slice(2);
const sources = new SourceRegistry();

console.log("Tool schema:", JSON.stringify(webSearchTool.parameters));
const t0 = performance.now();
const out = await webSearch(
  { query, topic: topic === "news" ? "news" : null, start_date: startDate ?? null, max_results: null },
  sources,
);
const ms = Math.round(performance.now() - t0);

if ("error" in out) {
  console.error(`Error after ${ms}ms:`, out.error);
  process.exit(1);
}
console.log(`\n"${out.query}" → ${out.results.length} results in ${ms}ms\n`);
for (const r of out.results) {
  console.log(`[${r.n}] ${r.title}\n    ${r.url}${r.published ? `  (${r.published})` : ""}\n    ${r.content.slice(0, 240)}…\n`);
}
console.log(`Payload to model: ${JSON.stringify(out).length} chars`);
