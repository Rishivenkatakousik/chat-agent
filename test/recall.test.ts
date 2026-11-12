import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db.js";
import { extractKeywords, hasMemoryCue, recall, type RecallResult } from "../src/agent/recall.js";
import { resolveTimeRefs } from "../src/agent/time.js";
import type { Embedder } from "../src/agent/embed.js";
import { seedDemo } from "../scripts/seed-data.js";

const TZ = "Asia/Kolkata";
const NOW = Date.parse("2026-11-11T07:00:00Z"); // Wed 11 Nov 2026, 12:30 IST

/** Deterministic "semantic" embedder: one dimension per concept, so synonyms land together without network. */
const CONCEPTS: RegExp[] = [
  /\b(crm|customer relationship|contact[- ]management|sales (?:tool|software|team)|pipedrive|hubspot|attio|folk|zoho)/gi,
  /\b(postgres|database|neon|supabase|rds|render)/gi,
  /\b(lisbon|trip|weekend|travel|itinerary)/gi,
];
const fakeEmbed: Embedder = async (text) => {
  const v = new Float32Array(CONCEPTS.length + 1);
  CONCEPTS.forEach((re, i) => (v[i] = (text.match(re) ?? []).length));
  v[CONCEPTS.length] = 0.2; // shared baseline so unrelated texts are not exactly orthogonal
  return v;
};

function setup(withEmbeddings = false) {
  const db = openDb(":memory:");
  const seeded = seedDemo(db, { now: NOW, timezone: TZ });
  return { db, seeded, withEmbeddings };
}

async function ask(db: ReturnType<typeof openDb>, message: string, embed?: Embedder): Promise<RecallResult> {
  const timeRefs = resolveTimeRefs(message, NOW, TZ);
  return recall({ db, message, timezone: TZ, timeRefs, embed });
}

const titles = (r: RecallResult) => [...new Set(r.exchanges.map((e) => e.conversationTitle))];

test("seed places conversations on the challenge dates", () => {
  const { seeded } = setup();
  const day = (t: string) => new Date(Date.parse(seeded.days[t]!) + 5.5 * 3600_000).toISOString().slice(0, 10);
  assert.equal(day("Managed Postgres hosting prices"), "2026-11-03");
  assert.equal(day("CRM shortlist for a 6-person sales team"), "2026-11-09");
  assert.equal(day("Weekend in Lisbon"), "2026-11-10");
});

test("keywords and memory cues", () => {
  const msg = "Last Tuesday I asked about Postgres hosting. Has pricing changed?";
  assert.deepEqual(extractKeywords(msg, resolveTimeRefs(msg, NOW, TZ)), ["postgres", "hosting", "pricing"]);
  assert.deepEqual(extractKeywords("What did I ask you on 3 November? Is it still correct?"), []);
  assert.deepEqual(extractKeywords("Is Next.js 16 faster than C++?"), ["next.js", "faster", "than", "c++"].filter((w) => w !== "than"));
  assert.ok(hasMemoryCue("On Monday we shortlisted 5 CRM tools"));
  assert.ok(hasMemoryCue("Has anything changed since?"));
  assert.ok(!hasMemoryCue("What's new in Postgres 18?"));
});

// ── The three challenge questions ──

test("challenge 1: 'On Monday we shortlisted 5 CRM tools' recalls the CRM exchange and its facts", async () => {
  const { db } = setup();
  const r = await ask(db, "On Monday we shortlisted 5 CRM tools. Has anything changed since?");
  assert.deepEqual(titles(r), ["CRM shortlist for a 6-person sales team"]);
  assert.equal(r.exchanges[0]!.reason, "date+topic");
  assert.ok(r.facts.some((f) => f.entity === "CRM shortlist" && f.value.includes("Pipedrive")));
  assert.match(r.memory, /Mon 9 Nov 2026, 15:00/);
  assert.match(r.memory, /Attio Plus/);
});

test("challenge 2: 'What did I ask you on 3 November?' returns everything from that day", async () => {
  const { db } = setup();
  const r = await ask(db, "What did I ask you on 3 November? Is it still correct?");
  assert.deepEqual(titles(r), ["Managed Postgres hosting prices"]);
  assert.equal(r.exchanges.length, 2, "both exchanges from 3 Nov");
  assert.ok(r.exchanges.every((e) => e.reason === "date"));
  assert.match(r.memory, /Tue 3 Nov 2026, 10:00/);
  assert.match(r.memory, /Neon · Launch plan price: \$19\/mo/);
});

test("challenge 3: ambiguous 'last Tuesday' picks the Tuesday that has Postgres, notes the other", async () => {
  const { db } = setup();
  const r = await ask(db, "Last Tuesday I asked about Postgres hosting. Has pricing changed?");
  assert.deepEqual(titles(r), ["Managed Postgres hosting prices"]);
  assert.ok(!/Lisbon/.test(r.memory.split("## Past exchanges")[1] ?? ""), "Lisbon exchange is not recalled");
  assert.ok(r.notes.some((n) => n.startsWith("Tue 10 Nov 2026") && /Weekend in Lisbon/.test(n) && /nothing about this topic/.test(n)));
  assert.ok(r.facts.some((f) => f.entity === "Supabase"));
  assert.ok(!r.facts.some((f) => f.entity === "Pipedrive"), "CRM prices don't leak in through the word 'pricing'");
  assert.match(r.memory, /Sources cited then: \[1\] https:\/\/neon.com\/pricing/);
});

// ── Honesty and precision ──

test("a date with no conversations is reported, nothing invented", async () => {
  const { db } = setup();
  const r = await ask(db, "What did we discuss on 5 November?");
  assert.equal(r.exchanges.length, 0);
  assert.deepEqual(r.notes, ['No conversations found on Thu 5 Nov 2026 ("5 November").']);
  assert.match(r.memory, /No conversations found on Thu 5 Nov 2026/);
});

test("no time phrase but a memory cue: global keyword recall", async () => {
  const { db } = setup();
  const r = await ask(db, "Has Supabase pricing changed since you quoted it?");
  assert.deepEqual(titles(r), ["Managed Postgres hosting prices"]);
  assert.equal(r.exchanges[0]!.reason, "topic");
});

test("an unrelated question recalls nothing", async () => {
  const { db } = setup();
  for (const q of ["What's 2+2?", "What's new in Postgres 18?", "Explain how TCP slow start works"]) {
    const r = await ask(db, q);
    assert.equal(r.exchanges.length, 0, q);
    assert.equal(r.memory, "", q);
  }
});

test("a strong multi-keyword match is recalled even without a cue", async () => {
  const { db } = setup();
  const r = await ask(db, "Neon vs Supabase pricing for 10 GB?");
  assert.deepEqual(titles(r), ["Managed Postgres hosting prices"]);
});

test("a fact search by entity name finds facts on its own", async () => {
  const { db } = setup();
  const r = await ask(db, "Did Pipedrive raise prices since we looked?");
  assert.ok(r.facts.some((f) => f.entity === "Pipedrive"));
  assert.ok(!r.facts.some((f) => f.entity === "Neon"));
});

test("embeddings bridge synonyms that keywords miss", async () => {
  const { db, seeded } = setup();
  for (const m of seeded.messages) db.setEmbedding(m.id, (await fakeEmbed(m.text))!);
  const q = "Remember the contact-management apps we looked at? Anything new?";
  const withoutVec = await ask(db, q);
  assert.equal(withoutVec.exchanges.length, 0, "no keyword overlap");
  const withVec = await ask(db, q, fakeEmbed);
  assert.equal(withVec.stats.usedEmbeddings, true);
  assert.deepEqual(titles(withVec), ["CRM shortlist for a 6-person sales team"]);
});

// ── Phrasings from real use (a user's transcript where recall missed) ──

test("'one day I have discussed…' with a typo and a missing space still finds the Lisbon chat", async () => {
  const { db } = setup();
  const q = "one day i have discussed about weekend in lisdon.can u give me the date when i have asked u";
  assert.ok(hasMemoryCue(q), "'i have discussed' and 'one day' are memory cues");
  assert.deepEqual(extractKeywords(q), ["weekend", "lisdon"], "\"lisdon.can\" is split; \"can\" is a stopword");
  const r = await ask(db, q);
  assert.deepEqual(titles(r), ["Weekend in Lisbon"], "'weekend' is distinctive, so one matching word is enough with a cue");
});

test("memory cue phrasings", () => {
  for (const q of [
    "did we talk about Neon?",
    "have I ever asked you about Redis",
    "we've already compared these",
    "you once suggested a CRM",
    "the other day you told me something",
    "what did I ask the other day",
    "I had discussed this a while ago",
  ]) assert.ok(hasMemoryCue(q), q);
  for (const q of ["What's new in Postgres 18?", "Explain TCP slow start", "best pizza in Lisbon"]) assert.ok(!hasMemoryCue(q), q);
});

test("a common word never recalls on its own, even with a cue", async () => {
  const { db } = setup();
  // "pricing"/"price" appears in several conversations, so it isn't distinctive.
  const r = await ask(db, "Did we talk about pricing before?");
  assert.equal(r.exchanges.length, 0);
});

test("semantic search runs on every message, not only on cues", async () => {
  const { db, seeded } = setup();
  for (const m of seeded.messages) db.setEmbedding(m.id, (await fakeEmbed(m.text))!);
  const r = await ask(db, "Pipedrive or HubSpot for a sales team?", fakeEmbed);
  assert.equal(r.stats.cue, false);
  assert.equal(r.stats.usedEmbeddings, true);
  assert.deepEqual(titles(r), ["CRM shortlist for a 6-person sales team"]);
});

test("excluded messages (already in the model's history) are not recalled", async () => {
  const { db } = setup();
  const crm = db.getMessages("seed-crm-shortlist").map((m) => m.id);
  const r = await recall({
    db,
    message: "On Monday we shortlisted 5 CRM tools. Has anything changed since?",
    timezone: TZ,
    timeRefs: resolveTimeRefs("On Monday", NOW, TZ),
    exclude: new Set(crm),
  });
  assert.equal(r.exchanges.length, 0);
});

test("memory stays within the character budget", async () => {
  const { db } = setup();
  const r = await recall({ db, message: "What did I ask you on 3 November?", timezone: TZ, timeRefs: resolveTimeRefs("3 November", NOW, TZ), charBudget: 1_500 });
  assert.ok(r.memory.length <= 1_500, `memory is ${r.memory.length} chars`);
  assert.ok(r.exchanges.length >= 1);
});
