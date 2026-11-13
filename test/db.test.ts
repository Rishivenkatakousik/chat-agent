import { test } from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../src/storage/database.js";
import { toFtsQuery } from "../src/storage/sql.js";

/** Storage layer: full-text search, date ranges, embeddings and facts, on an in-memory database. */

const at = (iso: string) => Date.parse(iso);

function setup() {
  const db = openDatabase(":memory:");
  const c1 = db.conversations.create({
    timezone: "Asia/Kolkata",
    title: "Postgres hosting",
    createdAt: at("2026-11-03T05:00:00Z"),
  });
  const q1 = db.messages.append({
    conversationId: c1.id,
    role: "user",
    text: "Compare Postgres hosting prices: Neon, Supabase, RDS",
    createdAt: at("2026-11-03T05:00:00Z"),
  });
  const a1 = db.messages.append({
    conversationId: c1.id,
    role: "assistant",
    text: "Neon Launch is $19/mo, Supabase Pro is $25/mo, RDS db.t4g.micro is about $12/mo.",
    sources: [{ n: 1, title: "Neon pricing", url: "https://neon.tech/pricing" }],
    createdAt: at("2026-11-03T05:00:10Z"),
  });
  const c2 = db.conversations.create({ timezone: "Asia/Kolkata", createdAt: at("2026-11-09T06:00:00Z") });
  db.messages.append({
    conversationId: c2.id,
    role: "user",
    text: "Shortlist 5 CRM tools for a small team",
    createdAt: at("2026-11-09T06:00:00Z"),
  });
  db.messages.append({
    conversationId: c2.id,
    role: "assistant",
    text: "HubSpot, Pipedrive, Attio, Folk, Close.",
    createdAt: at("2026-11-09T06:00:12Z"),
  });
  return { db, c1, c2, q1, a1 };
}

test("keyword search is stemmed and can be limited to a time window", () => {
  const { db, c1 } = setup();
  const hits = db.messages.search(toFtsQuery(["postgres", "price"])!);
  assert.equal(hits[0]!.conversation_id, c1.id, "'price' matches 'prices'");
  const nov9 = { start: at("2026-11-09T00:00:00Z"), end: at("2026-11-10T00:00:00Z") };
  assert.equal(db.messages.search(toFtsQuery(["postgres"])!, nov9).length, 0);
});

test("user text can't break the FTS query syntax", () => {
  const { db } = setup();
  assert.doesNotThrow(() => db.messages.search(toFtsQuery(["AND", "NEAR(", '"quote"', "c++", "OR", "*"])!));
  assert.equal(toFtsQuery(["", '""', "  "]), null);
});

test("date ranges, sources and exchanges round-trip", () => {
  const { db, q1, a1 } = setup();
  const nov3Ist = db.messages.listInWindow({
    start: at("2026-11-02T18:30:00Z"),
    end: at("2026-11-03T18:30:00Z"),
  });
  assert.deepEqual(
    nov3Ist.map((m) => m.id),
    [q1.id, a1.id],
  );
  assert.equal(nov3Ist[1]!.sources[0]!.url, "https://neon.tech/pricing");
  assert.deepEqual(
    db.messages.getExchange(a1.id).map((m) => m.role),
    ["user", "assistant"],
    "expands from the answer side too",
  );
});

test("embeddings round-trip as Float32", () => {
  const { db, q1 } = setup();
  assert.equal(db.messages.hasEmbeddings(), false);
  db.messages.setEmbedding(q1.id, new Float32Array([0.1, 0.2, 0.3]));
  const [row] = db.messages.listEmbeddings();
  assert.ok(db.messages.hasEmbeddings());
  assert.ok(Math.abs(row!.embedding[2]! - 0.3) < 1e-6);
  assert.equal(db.messages.listMissingEmbedding().length, 3);
});

test("facts are searchable by name", () => {
  const { db, c1, a1 } = setup();
  db.facts.insert({
    conversationId: c1.id,
    messageId: a1.id,
    observedAt: a1.created_at,
    facts: [
      {
        entity: "Neon",
        attribute: "Launch plan price",
        value: "$19/mo",
        source_url: "https://neon.tech/pricing",
      },
      { entity: "Supabase", attribute: "Pro plan price", value: "$25/mo" },
    ],
  });
  assert.equal(db.facts.listForMessages([a1.id]).length, 2);
  assert.equal(db.facts.search(toFtsQuery(["neon"])!)[0]!.value, "$19/mo");
});

test("deleting a conversation also removes its search index rows and facts", () => {
  const { db, c1, c2, a1 } = setup();
  db.facts.insert({
    conversationId: c1.id,
    messageId: a1.id,
    facts: [{ entity: "Neon", attribute: "price", value: "$19" }],
  });
  assert.equal(db.conversations.list()[0]!.id, c2.id, "most recently updated first");
  assert.ok(db.conversations.delete(c1.id));
  assert.equal(db.messages.search(toFtsQuery(["neon"])!).length, 0);
  assert.equal(db.facts.search(toFtsQuery(["neon"])!).length, 0);
  assert.equal(db.messages.count(), 2);
});

test("nested transactions join the outer one", () => {
  const { db, c2 } = setup();
  assert.throws(() =>
    db.transaction(() => {
      db.messages.append({ conversationId: c2.id, role: "user", text: "inside" }); // opens its own transaction
      throw new Error("rollback");
    }),
  );
  assert.equal(
    db.messages.list(c2.id).length,
    2,
    "the inner insert was rolled back with the outer transaction",
  );
});

test("a question that was never answered doesn't borrow a later answer", () => {
  const { db, c2 } = setup();
  const unanswered = db.messages.append({
    conversationId: c2.id,
    role: "user",
    text: "Compare Neon and Supabase",
  });
  db.messages.append({ conversationId: c2.id, role: "user", text: "What is the capital of France?" });
  db.messages.append({ conversationId: c2.id, role: "assistant", text: "Paris." });
  assert.deepEqual(
    db.messages.getExchange(unanswered.id).map((m) => m.text),
    ["Compare Neon and Supabase"],
  );
});

test("a window keeps its newest messages and reports how many questions it holds", () => {
  const { db, c2 } = setup();
  const day = { start: at("2026-11-09T00:00:00Z"), end: at("2026-11-10T00:00:00Z") };
  assert.equal(db.messages.countQuestionsInWindow(day), 1);
  const newest = db.messages.listInWindow(day, 1);
  assert.deepEqual(
    newest.map((m) => m.role),
    ["assistant"],
    "with a limit, the latest message wins",
  );
  assert.equal(db.messages.listInWindow(day).length, 2);
  assert.equal(db.messages.list(c2.id)[0]!.id, db.messages.listInWindow(day)[0]!.id, "still oldest first");
});

test("deleting a conversation clears stored contexts, which may quote it", () => {
  const { db, c1, c2 } = setup();
  const question = db.messages.list(c2.id)[0]!;
  db.messages.setContext(question.id, "<context>recalled: Neon Launch is $19/mo</context>");
  db.conversations.delete(c1.id);
  assert.equal(db.messages.list(c2.id, { withContext: true })[0]!.context, null);
});
