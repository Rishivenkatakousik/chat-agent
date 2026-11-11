import type OpenAI from "openai";
import type { SearchOutput, SourceRegistry } from "../src/agent/search.js";

/** Scripted fake model and search for testing the agent loop without network access. */

/** One scripted model round: tool calls and/or text; `fail` throws; `delayMs` waits (honouring abort) before streaming. */
export type Round = { calls?: string[]; text?: string; fail?: string; delayMs?: number };

export function fakeClient(rounds: Round[]) {
  const requests: any[] = [];
  const client = {
    responses: {
      create: async (params: any, opts?: { signal?: AbortSignal }) => {
        requests.push(structuredClone(params));
        const r = rounds[requests.length - 1] ?? { text: "fallback" };
        if (r.delayMs) {
          await new Promise<void>((resolve, reject) => {
            const t = setTimeout(resolve, r.delayMs);
            opts?.signal?.addEventListener("abort", () => {
              clearTimeout(t);
              reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
            });
          });
        }
        if (r.fail) throw new Error(r.fail);
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

export function fakeSearch(log: string[]) {
  return async (args: unknown, sources: SourceRegistry): Promise<SearchOutput> => {
    const { query } = args as { query: string };
    log.push(query);
    const url = `https://example.com/${encodeURIComponent(query)}`;
    const n = sources.add({ title: query, url, published: null });
    return { query, results: [{ n, title: query, url, published: null, content: `about ${query}` }] };
  };
}
