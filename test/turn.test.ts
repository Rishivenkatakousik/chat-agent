import { test } from "node:test";
import assert from "node:assert/strict";
import { runTurn, type TurnEvent } from "../src/agent/agent-loop.js";
import { config } from "../src/config.js";
import { fakeClient, fakeSearch, type Round } from "./fakes.js";

/**
 * Exercises the agent loop with a scripted fake model and fake search, so the
 * control flow (parallel calls, rounds, caps, history, errors) is tested
 * without network access.
 */

const ctx = { now: Date.parse("2026-11-11T07:00:00Z"), timezone: "Asia/Kolkata" };

test("no search: streams text and finishes in one round", async () => {
  const { client, requests } = fakeClient([{ text: "Two plus two is four." }]);
  const events: TurnEvent[] = [];
  const res = await runTurn({
    message: "2+2?",
    history: [],
    context: ctx,
    onEvent: (e) => events.push(e),
    deps: { client, search: fakeSearch([]) },
  });
  assert.equal(res.text, "Two plus two is four.");
  assert.equal(
    events
      .filter((e) => e.type === "text")
      .map((e) => (e as any).delta)
      .join(""),
    "Two plus two is four.",
  );
  assert.equal(events.at(-1)!.type, "done");
  assert.equal(res.stats.rounds, 1);
  assert.equal(res.stats.searches, 0);
  assert.equal(res.stats.cachedTokens, 80);
  assert.equal(requests[0].store, false);
  assert.equal(requests[0].tool_choice, "auto");
  assert.match(requests[0].input.at(-1).content, /^<context>\nCurrent time: Wednesday 11 Nov 2026/);
});

test("parallel searches, results fed back, cited sources only", async () => {
  const { client, requests } = fakeClient([
    { calls: ["neon pricing", "supabase pricing"] },
    { text: "Neon is $19 [1]. Supabase is $25 [2]." },
  ]);
  const log: string[] = [];
  const events: TurnEvent[] = [];
  const res = await runTurn({
    message: "compare",
    history: [],
    context: ctx,
    onEvent: (e) => events.push(e),
    deps: { client, search: fakeSearch(log) },
  });

  assert.deepEqual(log, ["neon pricing", "supabase pricing"]);
  assert.deepEqual(
    events
      .filter((e) => e.type === "status")
      .map((e) => (e as any).text)
      .slice(0, 2),
    ["Searching: neon pricing", "Searching: supabase pricing"],
  );
  // Round 2 input: original user msg + round-1 output (reasoning + 2 calls) + 2 outputs.
  const second = requests[1].input;
  assert.deepEqual(
    second.map((i: any) => i.type ?? i.role),
    ["user", "reasoning", "function_call", "function_call", "function_call_output", "function_call_output"],
  );
  assert.match(second.at(-1).output, /supabase pricing/);
  assert.deepEqual(
    res.sources.map((s) => s.n),
    [1, 2],
  );
  assert.equal(res.stats.rounds, 2);
});

test("search cap: extra calls get an error and the next round disables tools", async () => {
  const cap = config.maxSearchesPerTurn;
  const many = Array.from({ length: cap + 2 }, (_, i) => `q${i}`);
  const { client, requests } = fakeClient([{ calls: many }, { text: "Done [1]." }]);
  const log: string[] = [];
  const res = await runTurn({
    message: "x",
    history: [],
    context: ctx,
    onEvent: () => {},
    deps: { client, search: fakeSearch(log) },
  });
  assert.equal(log.length, cap);
  assert.equal(res.stats.searches, cap);
  const outputs = requests[1].input.filter((i: any) => i.type === "function_call_output");
  assert.equal(outputs.length, cap + 2, "every call gets an output");
  assert.match(outputs.at(-1).output, /Search limit/);
  assert.equal(requests[1].tool_choice, "none");
});

test("round limit: two search rounds, then the model must answer", async () => {
  const rounds: Round[] = [{ calls: ["a"] }, { calls: ["b"] }, { text: "Final [1]." }];
  const { client, requests } = fakeClient(rounds);
  const res = await runTurn({
    message: "x",
    history: [],
    context: ctx,
    onEvent: () => {},
    deps: { client, search: fakeSearch([]) },
  });
  assert.equal(requests.length, 3);
  assert.deepEqual(
    requests.map((r: any) => r.tool_choice),
    ["auto", "auto", "none"],
  );
  assert.equal(res.text, "Final [1].");
  assert.equal(res.stats.rounds, 3);
  assert.ok(
    res.stats.timeline.some((t) => t.what.startsWith("search done")),
    "timeline records searches",
  );
});

test("a wide first round (2+ searches) goes straight to the answer", async () => {
  const { client, requests } = fakeClient([{ calls: ["a", "b"] }, { text: "Answer [1][2][3]." }]);
  await runTurn({
    message: "x",
    history: [],
    context: ctx,
    onEvent: () => {},
    deps: { client, search: fakeSearch([]) },
  });
  assert.deepEqual(
    requests.map((r: any) => r.tool_choice),
    ["auto", "none"],
  );
});

test("a narrow first round keeps the follow-up search", async () => {
  const { client, requests } = fakeClient([
    { calls: ["who makes zed"] },
    { calls: ["zed industries founders"] },
    { text: "Answer [2]." },
  ]);
  await runTurn({
    message: "x",
    history: [],
    context: ctx,
    onEvent: () => {},
    deps: { client, search: fakeSearch([]) },
  });
  assert.deepEqual(
    requests.map((r: any) => r.tool_choice),
    ["auto", "auto", "none"],
  );
});

test("preamble text before a search is kept, separated from the answer", async () => {
  const { client } = fakeClient([{ calls: ["x"], text: "Let me check." }, { text: "Answer [1]." }]);
  const events: TurnEvent[] = [];
  const res = await runTurn({
    message: "x",
    history: [],
    context: ctx,
    onEvent: (e) => events.push(e),
    deps: { client, search: fakeSearch([]) },
  });
  assert.equal(res.text, "Let me check.\n\nAnswer [1].");
  assert.equal(
    events
      .filter((e) => e.type === "text")
      .map((e) => (e as any).delta)
      .join(""),
    res.text,
  );
});

test("history is trimmed to start with a user message", async () => {
  const { client, requests } = fakeClient([{ text: "ok" }]);
  const mk = (id: number, role: "user" | "assistant", text: string) => ({
    id,
    conversation_id: "c",
    role,
    text,
    sources: [],
    created_at: id,
  });
  const history = [mk(1, "assistant", "orphan reply"), mk(2, "user", "hi"), mk(3, "assistant", "hello")];
  await runTurn({
    message: "next",
    history,
    context: ctx,
    onEvent: () => {},
    deps: { client, search: fakeSearch([]) },
  });
  assert.deepEqual(
    requests[0].input.map((i: any) => [i.role, i.content.slice(0, 5)]),
    [
      ["user", "hi"],
      ["assistant", "hello"],
      ["user", "<cont"],
    ],
  );
});

test("empty answer is an error", async () => {
  const { client } = fakeClient([{}]);
  await assert.rejects(
    runTurn({
      message: "x",
      history: [],
      context: ctx,
      onEvent: () => {},
      deps: { client, search: fakeSearch([]) },
    }),
    /empty answer/,
  );
});

test("recent questions are replayed with the context (memory) the model saw then", async () => {
  const { client, requests } = fakeClient([{ text: "ok" }]);
  const mk = (id: number, role: "user" | "assistant", text: string, context?: string) => ({
    id,
    conversation_id: "c",
    role,
    text,
    sources: [],
    created_at: id,
    context,
  });
  const history = [
    mk(1, "user", "q1", "<context>old</context>"),
    mk(2, "assistant", "a1"),
    mk(3, "user", "q2", "<context>memory: Lisbon on Tue 10 Nov 19:00</context>"),
    mk(4, "assistant", "You asked on Tue 10 Nov at 19:00."),
    mk(5, "user", "q3", "<context>c3</context>"),
    mk(6, "assistant", "a3"),
    mk(7, "user", "q4", "<context>c4</context>"),
    mk(8, "assistant", "a4"),
  ];
  await runTurn({
    message: "why wasn't it available earlier?",
    history,
    context: ctx,
    onEvent: () => {},
    deps: { client, search: fakeSearch([]) },
  });
  const contents = requests[0].input.map((i: any) => i.content as string);
  assert.equal(contents[0], "q1", "older than the last 3 user turns: plain text");
  assert.equal(contents[2], "<context>memory: Lisbon on Tue 10 Nov 19:00</context>\n\nq2");
  assert.equal(contents[4], "<context>c3</context>\n\nq3");
  assert.equal(contents[6], "<context>c4</context>\n\nq4");
  assert.equal(contents[3], "You asked on Tue 10 Nov at 19:00.", "assistant turns unchanged");
});
