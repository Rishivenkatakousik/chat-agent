import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/server.js";
import { openDb } from "../src/db.js";
import { fakeClient, fakeSearch, type Round } from "./fakes.js";
import { seedDemo } from "../scripts/seed-data.js";

/** HTTP + SSE path end to end, with a fake model and search and an in-memory database. */

function setup(rounds: Round[]) {
  const db = openDb(":memory:");
  const { client, requests } = fakeClient(rounds);
  const app = createApp(db, { deps: { client, search: fakeSearch([]), embed: null }, requireKeys: false });
  return { db, app, requests };
}

function chat(app: ReturnType<typeof createApp>, body: unknown, signal?: AbortSignal) {
  return app.request("/api/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal });
}

/** Parses an SSE body into [{event, data}] */
async function readSSE(res: Response) {
  const text = await res.text();
  return text
    .split("\n\n")
    .filter((b) => b.trim())
    .map((block) => {
      const event = /^event: (.*)$/m.exec(block)?.[1];
      const data = /^data: (.*)$/m.exec(block)?.[1];
      return { event, data: data ? JSON.parse(data) : null };
    });
}

test("POST /api/chat streams events in order and stores both messages", async () => {
  const { db, app } = setup([{ calls: ["neon pricing"] }, { text: "Neon Launch is $19/mo [1]." }]);
  const res = await chat(app, { message: "Neon pricing?", timezone: "Asia/Kolkata" });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);

  const events = await readSSE(res);
  const kinds = [...new Set(events.map((e) => e.event))];
  assert.deepEqual(kinds, ["conversation", "status", "text", "sources", "done"]);
  const convId = events[0]!.data.id as string;
  assert.equal(events[0]!.data.created, true);

  const done = events.at(-1)!.data;
  assert.equal(done.text, "Neon Launch is $19/mo [1].");
  assert.equal(done.sources[0].n, 1);

  const msgs = db.getMessages(convId);
  assert.deepEqual(msgs.map((m) => m.role), ["user", "assistant"]);
  assert.equal(msgs[1]!.id, done.messageId);
  assert.equal(msgs[1]!.sources[0]!.url, "https://example.com/neon%20pricing");
  assert.ok(msgs[1]!.created_at > msgs[0]!.created_at);
  assert.equal(db.getConversation(convId)!.timezone, "Asia/Kolkata");
});

test("follow-up in the same conversation sends history", async () => {
  const { app, requests } = setup([{ text: "First answer." }, { text: "Second answer." }]);
  const first = await readSSE(await chat(app, { message: "first question" }));
  const id = first[0]!.data.id;
  const second = await readSSE(await chat(app, { conversationId: id, message: "follow up" }));
  assert.equal(second[0]!.data.created, false);
  assert.deepEqual(requests[1].input.map((i: any) => i.role), ["user", "assistant", "user"]);
  assert.equal(requests[1].input[1].content, "First answer.");

  const list = await (await app.request("/api/conversations")).json();
  assert.equal(list.conversations.length, 1);
  const msgs = await (await app.request(`/api/conversations/${id}/messages`)).json();
  assert.equal(msgs.messages.length, 4);
});

test("model failure: error event, question kept, no partial answer stored", async () => {
  const { db, app } = setup([{ fail: "boom" }]);
  const events = await readSSE(await chat(app, { message: "hello" }));
  assert.equal(events.at(-1)!.event, "error");
  assert.equal(events.at(-1)!.data.message, "boom");
  const msgs = db.getMessages(events[0]!.data.id);
  assert.deepEqual(msgs.map((m) => m.role), ["user"]);
});

test("validation and lookup errors", async () => {
  const { app } = setup([]);
  assert.equal((await chat(app, { message: "" })).status, 400);
  assert.equal((await chat(app, { nope: 1 })).status, 400);
  assert.equal((await chat(app, { message: "   " })).status, 400);
  assert.equal((await chat(app, { conversationId: "missing", message: "hi" })).status, 404);
  assert.equal((await app.request("/api/conversations/missing/messages")).status, 404);
  assert.equal((await app.request("/api/conversations/missing", { method: "DELETE" })).status, 404);
});

test("a second message while the first is still answering gets 409", async () => {
  const { app } = setup([{ text: "warm-up" }, { delayMs: 200, text: "slow" }]);
  const id = (await readSSE(await chat(app, { message: "start" })))[0]!.data.id;
  const slow = chat(app, { conversationId: id, message: "slow one" });
  await new Promise((r) => setTimeout(r, 30));
  const res = await chat(app, { conversationId: id, message: "too soon" });
  assert.equal(res.status, 409);
  await (await slow).text();
});

test("client disconnect aborts the run and stores no answer", async () => {
  const { db, app } = setup([{ delayMs: 5_000, text: "never" }]);
  const ac = new AbortController();
  const res = await chat(app, { message: "slow" }, ac.signal);
  const reader = res.body!.getReader();
  const first = new TextDecoder().decode((await reader.read()).value);
  const id = JSON.parse(/data: (.*)/.exec(first)![1]!).id;
  const t0 = Date.now();
  ac.abort();
  await reader.cancel().catch(() => {});
  // Busy flag clears quickly once the run notices the abort.
  while (Date.now() - t0 < 2_000 && db.getMessages(id).length === 1) {
    const r = await chat(app, { conversationId: id, message: "probe" });
    await r.text();
    if (r.status !== 409) break;
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.ok(Date.now() - t0 < 2_000, "run was aborted rather than waiting 5s");
  assert.ok(!db.getMessages(id).some((m) => m.text === "never"));
});

test("DELETE removes the conversation", async () => {
  const { db, app } = setup([{ text: "ok" }]);
  const id = (await readSSE(await chat(app, { message: "hi" })))[0]!.data.id;
  assert.equal((await app.request(`/api/conversations/${id}`, { method: "DELETE" })).status, 204);
  assert.equal(db.getConversation(id), undefined);
});

test("recall: the seeded Postgres exchange reaches the model's context through /api/chat", async () => {
  const db = openDb(":memory:");
  const now = Date.now();
  seedDemo(db, { now, timezone: "Asia/Kolkata" });
  const { client, requests } = fakeClient([{ text: "On that day you compared Neon, Supabase, Render and RDS." }]);
  const app = createApp(db, { deps: { client, search: fakeSearch([]), embed: null }, requireKeys: false });
  const events = await readSSE(await chat(app, { message: "Last Tuesday I asked about Postgres hosting. Has pricing changed?", timezone: "Asia/Kolkata" }));
  assert.equal(events.at(-1)!.event, "done");
  const userInput: string = requests[0].input.at(-1).content;
  assert.match(userInput, /<memory>[\s\S]*Managed Postgres hosting prices[\s\S]*Neon · Launch plan price[\s\S]*<\/memory>/);
  assert.doesNotMatch(userInput, /### .*Weekend in Lisbon/);
});

test("the context each question saw is stored and replayed in the next turn", async () => {
  const db = openDb(":memory:");
  seedDemo(db, { now: Date.now(), timezone: "Asia/Kolkata" });
  const { client, requests } = fakeClient([{ text: "You asked on that day about a Lisbon weekend." }, { text: "It was in memory then." }]);
  const app = createApp(db, { deps: { client, search: fakeSearch([]), embed: null }, requireKeys: false });
  const first = await readSSE(await chat(app, { message: "one day I have discussed a weekend in Lisbon, when was it?", timezone: "Asia/Kolkata" }));
  const id = first[0]!.data.id;
  const stored = db.getMessages(id, { withContext: true })[0]!;
  assert.match(stored.context ?? "", /^<context>[\s\S]*Weekend in Lisbon[\s\S]*<\/context>$/);
  assert.equal(db.getMessages(id)[0]!.context, undefined, "the UI's message list doesn't carry the context");

  await readSSE(await chat(app, { conversationId: id, message: "why wasn't it available earlier?" }));
  const replayed: string = requests[1].input[0].content;
  assert.equal(replayed, `${stored.context}\n\none day I have discussed a weekend in Lisbon, when was it?`);
  const msgs = await (await app.request(`/api/conversations/${id}/messages`)).json();
  assert.ok(!("context" in msgs.messages[0]));
});
