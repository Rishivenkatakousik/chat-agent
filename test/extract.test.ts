import { test } from "node:test";
import assert from "node:assert/strict";
import { settleBackground } from "../src/chat/chat-service.js";
import { backfillEmbeddings, enrichExchange, sanitizeFacts } from "../src/memory/enrich.js";
import { createApp } from "../src/server/app.js";
import { openDatabase, type Database } from "../src/storage/database.js";
import { fakeClient, fakeSearch } from "./fakes.js";

const fakeEmbedMany = async (texts: string[]) => texts.map((t) => Float32Array.from([t.length, 1, 0]));

function exchange(db: Database, opts: { title?: string; answer?: string; sources?: boolean } = {}) {
  const conv = db.conversations.create({ timezone: "UTC", title: opts.title ?? null });
  const q = db.messages.append({ conversationId: conv.id, role: "user", text: "Neon vs Supabase pricing?" });
  const a = db.messages.append({
    conversationId: conv.id,
    role: "assistant",
    text: opts.answer ?? "Neon Launch is $19/mo [1]; Supabase Pro is $25/mo [2].",
    sources:
      opts.sources === false
        ? []
        : [
            { n: 1, title: "Neon", url: "https://neon.com/pricing" },
            { n: 2, title: "Supabase", url: "https://supabase.com/pricing" },
          ],
  });
  return { conv, q, a };
}

const EXTRACTED = {
  title: '"Neon vs Supabase pricing."',
  facts: [
    {
      entity: "Neon",
      attribute: "Launch plan price",
      value: "$19/mo",
      source_url: "https://neon.com/pricing",
    },
    {
      entity: "Supabase",
      attribute: "Pro plan price",
      value: "$25/mo",
      source_url: "https://made-up.example.com",
    },
    { entity: "neon", attribute: "launch plan price", value: "duplicate", source_url: null },
    { entity: " ", attribute: "x", value: "y", source_url: null },
  ],
};

test("enrichExchange stores sanitized facts, a cleaned title and embeddings", async () => {
  const db = openDatabase(":memory:");
  const { conv, q, a } = exchange(db);
  const { client, extractRequests } = fakeClient([], EXTRACTED);
  const res = await enrichExchange(db, q, a, { client, embedMany: fakeEmbedMany });

  assert.deepEqual(res, { title: "Neon vs Supabase pricing", facts: 2, embedded: 2 });
  assert.equal(db.conversations.get(conv.id)!.title, "Neon vs Supabase pricing");
  const facts = db.facts.listForMessages([a.id]);
  assert.deepEqual(
    facts.map((f) => [f.entity, f.value, f.source_url]),
    [
      ["Neon", "$19/mo", "https://neon.com/pricing"],
      ["Supabase", "$25/mo", null], // URL not among the cited sources is dropped
    ],
  );
  assert.equal(facts[0]!.observed_at, a.created_at);
  assert.equal(db.messages.listEmbeddings().length, 2);

  const req = extractRequests[0];
  assert.equal(req.text.format.type, "json_schema");
  assert.equal(req.text.format.strict, true);
  assert.match(req.input, /Title requested: yes/);
  assert.match(req.input, /\[1\] https:\/\/neon.com\/pricing/);
});

test("titled conversation: title is not requested or overwritten", async () => {
  const db = openDatabase(":memory:");
  const { conv, q, a } = exchange(db, { title: "My title" });
  const { client, extractRequests } = fakeClient([], EXTRACTED);
  const res = await enrichExchange(db, q, a, { client, embedMany: fakeEmbedMany });
  assert.equal(res.title, null);
  assert.equal(db.conversations.get(conv.id)!.title, "My title");
  assert.match(extractRequests[0].input, /Title requested: no/);
});

test("nothing checkable and already titled: no model call, embeddings only", async () => {
  const db = openDatabase(":memory:");
  const { q, a } = exchange(db, {
    title: "Chat",
    answer: "Happy to help! What else would you like to know?",
    sources: false,
  });
  const { client, extractRequests } = fakeClient([], EXTRACTED);
  const res = await enrichExchange(db, q, a, { client, embedMany: fakeEmbedMany });
  assert.equal(extractRequests.length, 0);
  assert.deepEqual(res, { title: null, facts: 0, embedded: 2 });
});

test("extraction failure is contained: no throw, embeddings still saved", async () => {
  const db = openDatabase(":memory:");
  const { q, a } = exchange(db);
  const { client } = fakeClient([], new Error("model down"));
  const res = await enrichExchange(db, q, a, { client, embedMany: fakeEmbedMany });
  assert.deepEqual(res, { title: null, facts: 0, embedded: 2 });
});

test("conversation deleted mid-extraction: nothing is written", async () => {
  const db = openDatabase(":memory:");
  const { conv, q, a } = exchange(db);
  const { client } = fakeClient([], EXTRACTED);
  const slow = {
    responses: {
      create: async (p: any, o: any) => {
        db.conversations.delete(conv.id);
        return client.responses.create(p, o);
      },
    },
  } as any;
  const res = await enrichExchange(db, q, a, { client: slow, embedMany: fakeEmbedMany });
  assert.equal(res.facts, 0);
  assert.equal(db.connection.prepare("select count(*) n from facts").get()!.n, 0);
});

test("sanitizeFacts caps the number of facts", () => {
  const many = Array.from({ length: 30 }, (_, i) => ({
    entity: `E${i}`,
    attribute: "price",
    value: "$1",
    source_url: null,
  }));
  const a = { id: 1, conversation_id: "c", role: "assistant" as const, text: "", sources: [], created_at: 0 };
  assert.equal(sanitizeFacts(many, a).length, 20);
});

test("backfillEmbeddings fills messages that have no vector", async () => {
  const db = openDatabase(":memory:");
  exchange(db);
  exchange(db);
  assert.equal(await backfillEmbeddings(db, { embedMany: fakeEmbedMany }), 4);
  assert.equal(db.messages.listMissingEmbedding().length, 0);
  assert.equal(await backfillEmbeddings(db, { embedMany: fakeEmbedMany }), 0);
});

// ── Through the HTTP path ──

async function readSSE(res: Response) {
  return (await res.text())
    .split("\n\n")
    .filter((b) => b.trim())
    .map((b) => ({ event: /^event: (.*)$/m.exec(b)?.[1], data: JSON.parse(/^data: (.*)$/m.exec(b)![1]!) }));
}

test("after a pricing answer: title event, facts in the db, title in the list, and later recall uses the facts", async () => {
  const db = openDatabase(":memory:");
  const { client, requests } = fakeClient(
    [
      { calls: ["neon pricing"] },
      { text: "Neon Launch is $19/mo [1]." },
      { text: "Earlier I quoted $19/mo." },
    ],
    {
      title: "Neon pricing",
      facts: [
        {
          entity: "Neon",
          attribute: "Launch plan price",
          value: "$19/mo",
          source_url: "https://example.com/neon%20pricing",
        },
      ],
    },
  );
  const app = createApp(db, {
    deps: { client, search: fakeSearch([]), embed: null, embedMany: fakeEmbedMany },
    requireKeys: false,
  });
  const post = (body: object) =>
    app.request("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  const events = await readSSE(await post({ message: "What does Neon cost?" }));
  assert.deepEqual(
    events.slice(-2).map((e) => e.event),
    ["done", "title"],
  );
  const convId = events[0]!.data.id;
  assert.equal(events.at(-1)!.data.title, "Neon pricing");
  await settleBackground();

  const list = await (await app.request("/api/conversations")).json();
  assert.equal(list.conversations[0].title, "Neon pricing");
  const facts = db.connection
    .prepare("select entity, value, source_url from facts where conversation_id = ?")
    .all(convId);
  assert.deepEqual(
    facts.map((f: any) => [f.entity, f.value, f.source_url]),
    [["Neon", "$19/mo", "https://example.com/neon%20pricing"]],
  );
  assert.equal(db.messages.listMissingEmbedding().length, 0, "question and answer embedded");

  // A new conversation asking about it later gets the extracted fact in memory.
  const later = await readSSE(await post({ message: "Has Neon pricing changed since you quoted it?" }));
  assert.equal(later.find((e) => e.event === "done")!.data.text, "Earlier I quoted $19/mo.");
  const memory: string = requests[2].input.at(-1).content;
  assert.match(memory, /### .*"Neon pricing" \(matches the topic\)/);
  assert.match(
    memory,
    /- Neon · Launch plan price: \$19\/mo \(recorded .*https:\/\/example.com\/neon%20pricing\)/,
  );
});
