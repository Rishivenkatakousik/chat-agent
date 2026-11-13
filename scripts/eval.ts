// Answer-quality checks against the live model and search (uses your API keys; costs a few cents).
//   npm run eval [-- --only=N] [--answers]
// Unit tests cover the plumbing with fakes. This checks what a user sees: did the answer find the
// right day, search when it should (and not when it shouldn't), name every item, and cite real sources?
// Each case runs on a fresh in-memory database, seeded with the demo history unless it says otherwise.
import { startChat } from "../src/chat/chat-service.js";
import { openDatabase, type Database } from "../src/storage/database.js";
import { formatDay } from "../src/time/format.js";
import type { Source } from "../src/types.js";
import { seedDemo } from "./seed-data.js";

const TZ = "Asia/Kolkata";

interface Outcome {
  text: string;
  sources: Source[];
  searches: number;
}

type Check = [label: string, passes: (outcome: Outcome) => boolean];

interface Case {
  name: string;
  /** false = an empty database (a first-time user). */
  seeded?: boolean;
  /** Asked first, in the same conversation; only the answer to `question` is checked. */
  setup?: string;
  question: string | ((days: Record<string, string>) => string);
  checks: Check[] | ((days: Record<string, string>) => Check[]);
}

// ── Checks ──────────────────────────────────────────────────────────

const searched: Check = ["searched the web", (o) => o.searches > 0];
const didNotSearch: Check = ["did not search", (o) => o.searches === 0];
const citesRealSources: Check = [
  "has citations, and every [n] has a source",
  (o) => {
    const cited = [...o.text.matchAll(/\[(\d+)\]/g)].map((match) => Number(match[1]));
    return cited.length > 0 && cited.every((n) => o.sources.some((source) => source.n === n));
  },
];
const saysNothingFound: Check = [
  "says it has no record",
  (o) =>
    /couldn['’]t find|could not find|no record|don['’]t have|didn['’]t find|no (?:past )?conversation|nothing/i.test(
      o.text,
    ),
];
const mentions = (...words: string[]): Check => [
  `mentions ${words.join(", ")}`,
  (o) => words.every((word) => o.text.toLowerCase().includes(word.toLowerCase())),
];
const doesNotMention = (word: string): Check => [
  `does not mention ${word}`,
  (o) => !o.text.toLowerCase().includes(word.toLowerCase()),
];
/** The answer names the day of a seeded conversation, as "3 Nov…" or "Nov… 3". */
const namesDay = (iso: string): Check => {
  const [, day, month] = formatDay(Date.parse(iso), TZ).split(" "); // "Tue 3 Nov 2026"
  const pattern = new RegExp(`\\b${day}(?:st|nd|rd|th)?\\s+${month}|\\b${month}[a-z]*\\.?\\s+${day}\\b`, "i");
  return [`names the day (${day} ${month})`, (o) => pattern.test(o.text)];
};

const POSTGRES = "Managed Postgres hosting prices";
const CRM = "CRM shortlist for a 20-person sales team";
const CRM_TOOLS = ["HubSpot", "Pipedrive", "Attio", "Folk", "Zoho"];

// ── Cases ───────────────────────────────────────────────────────────

const CASES: Case[] = [
  {
    name: "challenge 1: weekday + shortlist + what changed",
    question:
      "On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?",
    checks: (days) => [namesDay(days[CRM]!), mentions(...CRM_TOOLS), searched, citesRealSources],
  },
  {
    name: "challenge 2: exact date + still correct",
    question: (days) => {
      const [, day, month] = formatDay(Date.parse(days[POSTGRES]!), TZ).split(" ");
      return `What did I ask you on ${day} ${month}? Is your answer still correct today?`;
    },
    checks: [mentions("Postgres", "Neon", "Supabase"), searched, citesRealSources],
  },
  {
    name: "challenge 3: 'last Tuesday' + pricing changed",
    question: "Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?",
    checks: (days) => [namesDay(days[POSTGRES]!), mentions("Neon"), searched, citesRealSources],
  },
  {
    name: "paraphrased date: 'Tuesday of last week'",
    question: "What did you tell me about Neon's price on Tuesday of last week?",
    checks: (days) => [namesDay(days[POSTGRES]!), mentions("$19")],
  },
  {
    name: "a date with an unrelated chat",
    question: "What did I ask you yesterday?",
    checks: [mentions("Lisbon"), didNotSearch],
  },
  {
    name: "a date with no history: says so, invents nothing",
    question: "What did we discuss 40 days ago?",
    checks: [saysNothingFound, didNotSearch],
  },
  {
    name: "empty database: no record, no invented prices",
    seeded: false,
    question: "Last Tuesday I asked you about Postgres hosting. What prices did you give me?",
    checks: [saysNothingFound, doesNotMention("$19")],
  },
  {
    name: "stable knowledge: answers without searching",
    question: "Explain the difference between a mutex and a semaphore in two sentences.",
    checks: [didNotSearch],
  },
  {
    name: "fresh facts: searches and cites",
    question: "What's new in the latest Node.js release?",
    checks: [searched, citesRealSources],
  },
  {
    name: "follow-up reuses the conversation instead of searching again",
    seeded: false,
    setup: "Compare Neon and Supabase pricing for a small app with about 10 GB of data.",
    question: "Which of the two is cheaper for that?",
    checks: [
      didNotSearch,
      [
        "every [n] it reuses still has a source",
        (o) => [...o.text.matchAll(/\[(\d+)\]/g)].every((m) => o.sources.some((s) => s.n === Number(m[1]))),
      ],
    ],
  },
];

// ── Runner ──────────────────────────────────────────────────────────

async function ask(db: Database, message: string, conversationId?: string) {
  let outcome: Outcome | undefined;
  let error = "";
  const chat = startChat({
    db,
    conversationId,
    message,
    timezone: TZ,
    onEvent: (event) => {
      if (event.type === "done") {
        outcome = { text: event.text, sources: event.sources, searches: event.stats.searches };
      }
      if (event.type === "error") error = event.message;
    },
  });
  await chat.run();
  return { outcome, error, conversationId: chat.conversationId };
}

const args = process.argv.slice(2);
const only = Number(args.find((arg) => arg.startsWith("--only="))?.split("=")[1] ?? NaN);
const showAnswers = args.includes("--answers");
const cases = Number.isInteger(only) ? [CASES[only]!] : CASES;

let failedChecks = 0;
for (const testCase of cases) {
  const db = openDatabase(":memory:");
  const days = testCase.seeded === false ? {} : seedDemo(db, { now: Date.now(), timezone: TZ }).days;
  const question = typeof testCase.question === "string" ? testCase.question : testCase.question(days);
  const checks = Array.isArray(testCase.checks) ? testCase.checks : testCase.checks(days);

  const conversationId = testCase.setup ? (await ask(db, testCase.setup)).conversationId : undefined;
  const { outcome, error } = await ask(db, question, conversationId);
  db.close();

  console.log(`\n${testCase.name}\n  Q: ${question}`);
  if (!outcome) {
    console.log(`  ✖ the turn failed: ${error}`);
    failedChecks += checks.length;
    continue;
  }
  for (const [label, passes] of checks) {
    const ok = passes(outcome);
    if (!ok) failedChecks++;
    console.log(`  ${ok ? "✔" : "✖"} ${label}`);
  }
  if (showAnswers) console.log(`\n${outcome.text.replace(/^/gm, "    │ ")}`);
}

console.log(failedChecks === 0 ? "\nAll checks passed." : `\n${failedChecks} check(s) failed.`);
process.exit(failedChecks === 0 ? 0 : 1);
