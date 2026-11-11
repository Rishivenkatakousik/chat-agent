// Smoke test for the storage layer: `npx tsx scripts/smoke-db.ts`. Uses an in-memory DB.
import assert from "node:assert/strict";
import { openDb, toFtsQuery } from "../src/db.js";

const db = openDb(":memory:");
const day = (iso: string) => Date.parse(iso);

const c1 = db.createConversation({ timezone: "Asia/Kolkata", title: "Postgres hosting", createdAt: day("2026-11-03T05:00:00Z") });
const q1 = db.appendMessage({ conversationId: c1.id, role: "user", text: "Compare Postgres hosting prices: Neon, Supabase, RDS", createdAt: day("2026-11-03T05:00:00Z") });
const a1 = db.appendMessage({
  conversationId: c1.id,
  role: "assistant",
  text: "Neon Launch is $19/mo, Supabase Pro is $25/mo, RDS db.t4g.micro is about $12/mo.",
  sources: [{ n: 1, title: "Neon pricing", url: "https://neon.tech/pricing" }],
  createdAt: day("2026-11-03T05:00:10Z"),
});

const c2 = db.createConversation({ timezone: "Asia/Kolkata", createdAt: day("2026-11-09T06:00:00Z") });
db.appendMessage({ conversationId: c2.id, role: "user", text: "Shortlist 5 CRM tools for a small team", createdAt: day("2026-11-09T06:00:00Z") });
db.appendMessage({ conversationId: c2.id, role: "assistant", text: "HubSpot, Pipedrive, Attio, Folk, Close.", createdAt: day("2026-11-09T06:00:12Z") });

// FTS (porter stemming: "price" matches "prices")
const hits = db.searchMessages(toFtsQuery(["postgres", "price"])!);
assert.ok(hits.length >= 1 && hits[0]!.conversation_id === c1.id, "FTS finds the Postgres exchange");
assert.equal(db.searchMessages(toFtsQuery(["postgres"])!, { start: day("2026-11-09T00:00:00Z"), end: day("2026-11-10T00:00:00Z") }).length, 0, "window filters FTS");

// Date range
const nov3 = db.messagesInRange(day("2026-11-02T18:30:00Z"), day("2026-11-03T18:30:00Z")); // 3 Nov in IST
assert.deepEqual(nov3.map((m) => m.id), [q1.id, a1.id], "range returns the 3 Nov exchange");
assert.equal(nov3[1]!.sources[0]!.url, "https://neon.tech/pricing", "sources round-trip");

// Exchange expansion from the assistant side
assert.deepEqual(db.getExchange(a1.id).map((m) => m.role), ["user", "assistant"]);

// Embeddings round-trip
db.setEmbedding(q1.id, new Float32Array([0.1, 0.2, 0.3]));
const embs = db.allEmbeddings();
assert.equal(embs.length, 1);
assert.ok(Math.abs(embs[0]!.embedding[2]! - 0.3) < 1e-6);

// Facts
db.insertFacts({ conversationId: c1.id, messageId: a1.id, observedAt: a1.created_at, facts: [
  { entity: "Neon", attribute: "Launch plan price", value: "$19/mo", source_url: "https://neon.tech/pricing" },
  { entity: "Supabase", attribute: "Pro plan price", value: "$25/mo" },
] });
assert.equal(db.factsForMessages([a1.id]).length, 2);
assert.equal(db.searchFacts(toFtsQuery(["neon"])!)[0]!.value, "$19/mo");

// Hostile input can't break FTS syntax
assert.doesNotThrow(() => db.searchMessages(toFtsQuery(['AND', 'NEAR(', '"quote"', 'c++'])!));

// Listing and cascade delete
assert.equal(db.listConversations()[0]!.id, c2.id, "most recently updated first");
assert.ok(db.deleteConversation(c1.id));
assert.equal(db.searchMessages(toFtsQuery(["neon"])!).length, 0, "FTS rows removed with the conversation");
assert.equal(db.searchFacts(toFtsQuery(["neon"])!).length, 0, "facts removed with the conversation");

console.log("db smoke test: all checks passed");
