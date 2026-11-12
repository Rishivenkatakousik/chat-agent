// Latency benchmark over the full chat path (recall → model → searches → answer), on a seeded in-memory DB.
//   npx tsx scripts/bench.ts [label] [--only=N] [--timeline] [--answers]
// Settings come from env as usual (OPENAI_MODEL, OPENAI_REASONING_EFFORT, SEARCH_DEPTH, ...).
// Results are appended to data/bench.jsonl so runs with different settings can be compared.
import { appendFileSync } from "node:fs";
import { config } from "../src/config.js";
import { openDb } from "../src/db.js";
import { startChat } from "../src/chat.js";
import { seedDemo } from "./seed-data.js";
import type { TurnStats } from "../src/agent/turn.js";

const QUESTIONS = [
  "Last Tuesday I asked about Postgres hosting. Has pricing changed?",
  "On Monday we shortlisted 5 CRM tools. Has anything changed since?",
  "What's new in the latest Node.js release?",
  "Explain the difference between a mutex and a semaphore in two sentences.",
  "Who founded the company behind the Zed code editor, and what did they build before it?",
];

const args = process.argv.slice(2);
const label = args.find((a) => !a.startsWith("--")) ?? "run";
const only = Number(args.find((a) => a.startsWith("--only="))?.split("=")[1] ?? NaN);
const showTimeline = args.includes("--timeline");
const showAnswers = args.includes("--answers");
const timezone = "Asia/Kolkata";

const db = openDb(":memory:");
seedDemo(db, { now: Date.now(), timezone });

const rows: { q: string; firstTokenMs: number | null; totalMs: number; searches: number; rounds: number; chars: number }[] = [];
const questions = Number.isInteger(only) ? [QUESTIONS[only]!] : QUESTIONS;

for (const q of questions) {
  let stats: TurnStats | undefined;
  let text = "";
  let error = "";
  const t0 = performance.now();
  const { run } = startChat({
    db,
    message: q,
    timezone,
    onEvent: (e) => {
      if (e.type === "done") ((stats = e.stats), (text = e.text));
      if (e.type === "error") error = e.message;
    },
  });
  await run();
  const wall = Math.round(performance.now() - t0);
  if (!stats) {
    console.log(`✖ ${q}\n  ${error}`);
    continue;
  }
  rows.push({ q, firstTokenMs: stats.firstTokenMs, totalMs: stats.totalMs, searches: stats.searches, rounds: stats.rounds, chars: text.length });
  console.log(
    `${String(stats.firstTokenMs ?? "-").padStart(6)}ms first token · ${String(stats.totalMs).padStart(6)}ms answer · ${wall}ms incl. recall · ` +
      `${stats.searches} searches · ${stats.rounds} rounds · ${text.length} chars · in ${stats.inputTokens} (cached ${stats.cachedTokens}) out ${stats.outputTokens}\n  ${q}`,
  );
  if (showTimeline) for (const t of stats.timeline) console.log(`    ${String(t.at).padStart(6)}ms  ${t.what}`);
  if (showAnswers) console.log(`\n${text.replace(/^/gm, "    │ ")}\n`);
}

const avg = (xs: number[]) => Math.round(xs.reduce((a, b) => a + b, 0) / Math.max(xs.length, 1));
const summary = {
  label,
  at: new Date().toISOString(),
  model: config.chatModel,
  effort: config.reasoningEffort,
  avgFirstTokenMs: avg(rows.map((r) => r.firstTokenMs ?? r.totalMs)),
  avgTotalMs: avg(rows.map((r) => r.totalMs)),
  avgSearches: Number((rows.reduce((a, r) => a + r.searches, 0) / Math.max(rows.length, 1)).toFixed(1)),
  rows,
};
console.log(`\n[${label}] avg first token ${summary.avgFirstTokenMs}ms · avg answer ${summary.avgTotalMs}ms · avg searches ${summary.avgSearches}`);
appendFileSync("data/bench.jsonl", JSON.stringify(summary) + "\n");
process.exit(0);
