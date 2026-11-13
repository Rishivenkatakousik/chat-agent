// Latency benchmark over the full chat path (recall → model → searches → answer).
//   npm run bench -- [label] [--runs=5] [--only=N] [--timeline] [--answers]
// Every run starts from a fresh seeded in-memory database, so runs don't see each other's answers.
// One run is noise (searches and the model vary by seconds): compare medians over several runs.
// Settings come from env as usual (OPENAI_MODEL, OPENAI_REASONING_EFFORT, SEARCH_DEPTH, ...).
// Results are appended to data/bench.jsonl so runs with different settings can be compared.
import { appendFileSync } from "node:fs";
import type { TurnStats } from "../src/agent/agent-loop.js";
import { startChat } from "../src/chat/chat-service.js";
import { config } from "../src/config.js";
import { openDatabase } from "../src/storage/database.js";
import { seedDemo } from "./seed-data.js";

const QUESTIONS = [
  "Last Tuesday I asked about Postgres hosting. Has pricing changed?",
  "On Monday we shortlisted 5 CRM tools. Has anything changed since?",
  "What's new in the latest Node.js release?",
  "Explain the difference between a mutex and a semaphore in two sentences.",
  "Who founded the company behind the Zed code editor, and what did they build before it?",
];

const args = process.argv.slice(2);
const flag = (name: string) => args.find((arg) => arg.startsWith(`--${name}=`))?.split("=")[1];
const label = args.find((arg) => !arg.startsWith("--")) ?? "run";
const runs = Math.max(1, Number(flag("runs") ?? 5) || 5);
const only = Number(flag("only") ?? NaN);
const showTimeline = args.includes("--timeline");
const showAnswers = args.includes("--answers");
const timezone = "Asia/Kolkata";

/** The value below which `share` of the sorted values fall (0.5 = median). */
function percentile(values: number[], share: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(share * sorted.length) - 1)] ?? 0;
}

/** One question on a fresh database. Returns null (and prints the error) when the turn failed. */
async function runOnce(question: string): Promise<{ stats: TurnStats; text: string } | null> {
  const db = openDatabase(":memory:");
  seedDemo(db, { now: Date.now(), timezone });

  let stats: TurnStats | undefined;
  let text = "";
  let error = "";
  const { run } = startChat({
    db,
    message: question,
    timezone,
    onEvent: (event) => {
      if (event.type === "done") {
        stats = event.stats;
        text = event.text;
      }
      if (event.type === "error") error = event.message;
    },
  });
  await run();
  db.close();

  if (!stats) {
    console.log(`  ✖ ${error}`);
    return null;
  }
  return { stats, text };
}

interface BenchRow {
  q: string;
  runs: number;
  firstTokenMs: number;
  totalMs: number;
  p90TotalMs: number;
  searches: number;
}

const rows: BenchRow[] = [];
const questions = Number.isInteger(only) ? [QUESTIONS[only]!] : QUESTIONS;

for (const question of questions) {
  console.log(question);
  const results: TurnStats[] = [];

  for (let i = 0; i < runs; i++) {
    const result = await runOnce(question);
    if (!result) continue;
    const { stats, text } = result;
    results.push(stats);
    console.log(
      `  ${String(stats.firstTokenMs ?? "-").padStart(6)}ms first token · ${String(stats.totalMs).padStart(6)}ms answer · ` +
        `${stats.searches} searches · ${stats.rounds} rounds · in ${stats.inputTokens} (cached ${stats.cachedTokens}) out ${stats.outputTokens}`,
    );
    if (showTimeline) {
      for (const mark of stats.timeline) console.log(`      ${String(mark.at).padStart(6)}ms  ${mark.what}`);
    }
    if (showAnswers) console.log(`\n${text.replace(/^/gm, "    │ ")}\n`);
  }
  if (results.length === 0) continue;

  const row: BenchRow = {
    q: question,
    runs: results.length,
    firstTokenMs: percentile(
      results.map((stats) => stats.firstTokenMs ?? stats.totalMs),
      0.5,
    ),
    totalMs: percentile(
      results.map((stats) => stats.totalMs),
      0.5,
    ),
    p90TotalMs: percentile(
      results.map((stats) => stats.totalMs),
      0.9,
    ),
    searches: percentile(
      results.map((stats) => stats.searches),
      0.5,
    ),
  };
  rows.push(row);
  console.log(
    `  → median ${row.firstTokenMs}ms first token · ${row.totalMs}ms answer · p90 ${row.p90TotalMs}ms (${row.runs} runs)`,
  );
}

const average = (values: number[]) =>
  Math.round(values.reduce((sum, value) => sum + value, 0) / Math.max(values.length, 1));
const summary = {
  label,
  at: new Date().toISOString(),
  model: config.chatModel,
  effort: config.reasoningEffort,
  runsPerQuestion: runs,
  // Averages of the per-question medians.
  avgFirstTokenMs: average(rows.map((row) => row.firstTokenMs)),
  avgTotalMs: average(rows.map((row) => row.totalMs)),
  rows,
};
console.log(
  `\n[${label}] medians averaged over ${rows.length} questions: first token ${summary.avgFirstTokenMs}ms · answer ${summary.avgTotalMs}ms`,
);
appendFileSync("data/bench.jsonl", JSON.stringify(summary) + "\n");
process.exit(0);
