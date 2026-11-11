import { test } from "node:test";
import assert from "node:assert/strict";
import type OpenAI from "openai";
import { runTurn, type TurnEvent } from "../src/agent/turn.js";
import type { SearchOutput, SourceRegistry } from "../src/agent/search.js";
import { config } from "../src/config.js";

/**
 * Exercises the agent loop with a scripted fake model and fake search, so the
 * control flow (parallel calls, rounds, caps, history, errors) is tested
 * without network access.
 */

type Round = { calls?: string[]; text?: string };

function fakeClient(rounds: Round[]) {
  const requests: any[] = [];
  const client = {
    responses: {
      create: async (params: any) => {
        requests.push(structuredClone(params));
        const r = rounds[requests.length - 1] ?? { text: "fallback" };
        const output: any[] = [{ type: "reasoning", id: `rs_${requests.length}`, summary: [], encrypted_content: "x" }];
        async function* events() {
          for (const [i, q] of (r.calls ?? []).entries()) {
            const item = { type: "function_call", id: `fc_${i}`, call_id: `call_${requests.length}_${i}`, name: "web_search", arguments: JSON.stringify({ query: q, topic: null, start_date: null, max_results: null }) };
            output.push(item);
            yield { type: "response.output_item.done", item };
          }
          if (r.text) {
            for (const chunk of r.text.match(/.{1,8}/gs) ?? []) yield { type: "response.output_text.delta", delta: chunk };
            output.push({ type: "message", role: "assistant", content: [{ type: "output_text", text: r.text }] });
          }
          yield { type: "response.completed", response: { status: "completed", output, usage: { input_tokens: 100, input_tokens_details: { cached_tokens: 80 }, output_tokens: 20 } } };
        }
        return events();
      },
    },
  };
  return { client: client as unknown as Pick<OpenAI, "responses">, requests };
}

function fakeSearch(log: string[]) {
  return async (args: unknown, sources: SourceRegistry): Promise<SearchOutput> => {
    const { query } = args as { query: string };
    log.push(query);
    const url = `https://example.com/${encodeURIComponent(query)}`;
    const n = sources.add({ title: query, url, published: null });
    return { query, results: [{ n, title: query, url, published: null, content: `about ${query}` }] };
  };
}

const ctx = { now: Date.parse("2026-11-11T07:00:00Z"), timezone: "Asia/Kolkata" };

test("no search: streams text and finishes in one round", async () => {
  const { client, requests } = fakeClient([{ text: "Two plus two is four." }]);
  const events: TurnEvent[] = [];
  const res = await runTurn({ message: "2+2?", history: [], context: ctx, onEvent: (e) => events.push(e), deps: { client, search: fakeSearch([]) } });
  assert.equal(res.text, "Two plus two is four.");
  assert.equal(events.filter((e) => e.type === "text").map((e) => (e as any).delta).join(""), "Two plus two is four.");
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
  const res = await runTurn({ message: "compare", history: [], context: ctx, onEvent: (e) => events.push(e), deps: { client, search: fakeSearch(log) } });

  assert.deepEqual(log, ["neon pricing", "supabase pricing"]);
  assert.deepEqual(events.filter((e) => e.type === "status").map((e) => (e as any).text).slice(0, 2), ["Searching: neon pricing", "Searching: supabase pricing"]);
  // Round 2 input: original user msg + round-1 output (reasoning + 2 calls) + 2 outputs.
  const second = requests[1].input;
  assert.deepEqual(second.map((i: any) => i.type ?? i.role), ["user", "reasoning", "function_call", "function_call", "function_call_output", "function_call_output"]);
  assert.match(second.at(-1).output, /supabase pricing/);
  assert.deepEqual(res.sources.map((s) => s.n), [1, 2]);
  assert.equal(res.stats.rounds, 2);
});

test("search cap: extra calls get an error and the next round disables tools", async () => {
  const cap = config.maxSearchesPerTurn;
  const many = Array.from({ length: cap + 2 }, (_, i) => `q${i}`);
  const { client, requests } = fakeClient([{ calls: many }, { text: "Done [1]." }]);
  const log: string[] = [];
  const res = await runTurn({ message: "x", history: [], context: ctx, onEvent: () => {}, deps: { client, search: fakeSearch(log) } });
  assert.equal(log.length, cap);
  assert.equal(res.stats.searches, cap);
  const outputs = requests[1].input.filter((i: any) => i.type === "function_call_output");
  assert.equal(outputs.length, cap + 2, "every call gets an output");
  assert.match(outputs.at(-1).output, /Search limit/);
  assert.equal(requests[1].tool_choice, "none");
});

test("round limit: the last round forces a text answer", async () => {
  const rounds: Round[] = [{ calls: ["a"] }, { calls: ["b"] }, { calls: ["c"] }, { calls: ["d"] }, { text: "Final [1]." }];
  const { client, requests } = fakeClient(rounds);
  const res = await runTurn({ message: "x", history: [], context: ctx, onEvent: () => {}, deps: { client, search: fakeSearch([]) } });
  assert.equal(requests.length, 5);
  assert.equal(requests[4].tool_choice, "none");
  assert.equal(res.text, "Final [1].");
});

test("preamble text before a search is kept, separated from the answer", async () => {
  const { client } = fakeClient([{ calls: ["x"], text: "Let me check." }, { text: "Answer [1]." }]);
  const events: TurnEvent[] = [];
  const res = await runTurn({ message: "x", history: [], context: ctx, onEvent: (e) => events.push(e), deps: { client, search: fakeSearch([]) } });
  assert.equal(res.text, "Let me check.\n\nAnswer [1].");
  assert.equal(events.filter((e) => e.type === "text").map((e) => (e as any).delta).join(""), res.text);
});

test("history is trimmed to start with a user message", async () => {
  const { client, requests } = fakeClient([{ text: "ok" }]);
  const mk = (id: number, role: "user" | "assistant", text: string) => ({ id, conversation_id: "c", role, text, sources: [], created_at: id });
  const history = [mk(1, "assistant", "orphan reply"), mk(2, "user", "hi"), mk(3, "assistant", "hello")];
  await runTurn({ message: "next", history, context: ctx, onEvent: () => {}, deps: { client, search: fakeSearch([]) } });
  assert.deepEqual(requests[0].input.map((i: any) => [i.role, i.content.slice(0, 5)]), [["user", "hi"], ["assistant", "hello"], ["user", "<cont"]]);
});

test("empty answer is an error", async () => {
  const { client } = fakeClient([{}]);
  await assert.rejects(runTurn({ message: "x", history: [], context: ctx, onEvent: () => {}, deps: { client, search: fakeSearch([]) } }), /empty answer/);
});
