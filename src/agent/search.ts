import { tavily, type TavilyClient, type TavilySearchOptions } from "@tavily/core";
import { z } from "zod";
import type { FunctionTool } from "openai/resources/responses/responses";
import { config } from "../config.js";
import type { Source } from "../db.js";

/**
 * The agent's one tool: web search, backed by Tavily.
 *
 * Results are compacted (title, url, published date, ~1,200 chars of the most
 * relevant content) and numbered per turn so the model can cite them as [n]
 * and the UI can show the same numbers as source chips.
 */

const MAX_RESULTS = 8;
const DEFAULT_RESULTS = 5;
const CONTENT_CHARS = 1_200;
/**
 * Searches restricted to a vendor's own site return fewer, longer results: an official pricing page's
 * numbers rarely fit in a short snippet, and a missing number costs a whole extra model round (~8s).
 */
const DOMAIN_RESULTS = 3;
const DOMAIN_CONTENT_CHARS = 2_400;
const TIMEOUT_MS = 20_000;

// Strict-mode function schema: every field is required, optional ones are nullable.
export const webSearchArgs = z.strictObject({
  query: z
    .string()
    .describe("A focused natural-language query naming the product, vendor or topic, e.g. 'Neon Postgres pricing plans'. No search operators (site:, quotes, OR): use `domains` to target a site."),
  topic: z
    .enum(["general", "news"])
    .nullable()
    .describe("'news' for recent events, announcements and anything 'since' a date; 'general' (default) for docs, pricing pages and reference facts."),
  start_date: z
    .string()
    .nullable()
    .describe("YYYY-MM-DD. Only return pages published on or after this date. Use for 'what changed since X'. Leave null for pricing or docs pages, which often have no publish date and would be filtered out."),
  domains: z
    .array(z.string())
    .nullable()
    .describe("Restrict results to these sites, e.g. ['neon.com'] for Neon's own pricing page. Up to 5. Use for official pricing, docs and changelogs; null to search everywhere."),
  // Plain number (no .int()/.min()): keeps the schema simple for strict mode; clamped in code.
  max_results: z
    .number()
    .nullable()
    .describe(`Number of results, 1-${MAX_RESULTS}. Default ${DEFAULT_RESULTS}.`),
});

export type WebSearchArgs = z.infer<typeof webSearchArgs>;

const { $schema: _ignored, ...parameters } = z.toJSONSchema(webSearchArgs, { target: "draft-7" }) as Record<string, unknown>;

export const webSearchTool: FunctionTool = {
  type: "function",
  name: "web_search",
  description:
    "Search the web for current information. Returns numbered results with title, url, published date and relevant page content. " +
    "Run several searches in parallel when comparing multiple products. Cite results by their number, e.g. [3].",
  parameters,
  strict: true,
};

export interface SearchResult {
  /** Citation number, unique within the turn. */
  n: number;
  title: string;
  url: string;
  published: string | null;
  content: string;
}

export type SearchOutput = { query: string; results: SearchResult[] } | { query?: string; error: string };

/** Assigns stable citation numbers across all searches in one turn; the same URL keeps its number. */
export class SourceRegistry {
  private byUrl = new Map<string, Source>();

  add(r: { title: string; url: string; published: string | null }): number {
    const key = normalizeUrl(r.url);
    const existing = this.byUrl.get(key);
    if (existing) return existing.n;
    const n = this.byUrl.size + 1;
    this.byUrl.set(key, { n, title: r.title, url: r.url, ...(r.published ? { published: r.published } : {}) });
    return n;
  }

  list(): Source[] {
    return [...this.byUrl.values()];
  }

  /** Only the sources the answer actually cites, keeping their numbers. Falls back to all if none are cited. */
  cited(answer: string): Source[] {
    const used = new Set([...answer.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1])));
    const all = this.list();
    return used.size ? all.filter((s) => used.has(s.n)) : all;
  }
}

function normalizeUrl(url: string): string {
  try {
    const u = new URL(url);
    u.hash = "";
    for (const p of [...u.searchParams.keys()]) if (p.startsWith("utm_")) u.searchParams.delete(p);
    return u.toString().replace(/\/$/, "");
  } catch {
    return url;
  }
}

/** "Tue, 03 Nov 2026 10:00:00 GMT" → "2026-11-03"; null when missing or unparseable. */
function normalizeDate(s: string | undefined | null): string | null {
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : new Date(t).toISOString().slice(0, 10);
}

function compactContent(s: string, max = CONTENT_CHARS): string {
  const text = s.replace(/\s+/g, " ").trim();
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  return `${cut.slice(0, lastSpace > max * 0.8 ? lastSpace : max)}…`;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** "neon.com", "https://www.neon.com/pricing" → "neon.com"; null if it isn't a plausible host. */
function toDomain(s: string): string | null {
  const t = s.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").split(/[/?#\s]/)[0] ?? "";
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(t) ? t : null;
}

/** Removes `site:` operators from the query (also the `site.x.com` slip) and returns them as domains, merged with `domains`. */
export function splitSiteOperators(query: string, domains: string[]): { query: string; domains: string[] } {
  const found: string[] = [];
  const cleaned = query
    .replace(/(?:^|\s)site[:.]\s*(\S+)/gi, (m, target: string) => {
      const d = toDomain(target);
      if (!d) return m;
      found.push(d);
      return " ";
    })
    .replace(/\s+/g, " ")
    .trim();
  const all = [...new Set([...domains.map(toDomain), ...found].filter((d): d is string => Boolean(d)))].slice(0, 5);
  return { query: cleaned, domains: all };
}

let client: TavilyClient | undefined;
function getClient(): TavilyClient {
  client ??= tavily({ apiKey: config.tavilyApiKey });
  return client;
}

function errorMessage(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (/401|unauthori[sz]ed|invalid api key/i.test(msg)) return "Search is unavailable: the Tavily API key was rejected.";
  if (/429|rate limit|usage limit|exceeded/i.test(msg)) return "Search is rate-limited right now. Answer from what you already have and say so.";
  if (/timeout|timed out|ETIMEDOUT|aborted/i.test(msg)) return "The search timed out. Try a simpler query or answer from what you have.";
  return `Search failed: ${msg.slice(0, 200)}`;
}

/**
 * Runs one web_search call. Never throws: failures come back as `{error}` so the
 * model can retry with a different query or tell the user search is unavailable.
 */
export async function webSearch(rawArgs: unknown, sources: SourceRegistry): Promise<SearchOutput> {
  // Strict mode should always send every field, but treat a missing optional one as null rather than failing.
  const filled =
    rawArgs && typeof rawArgs === "object"
      ? { topic: null, start_date: null, domains: null, max_results: null, ...(rawArgs as Record<string, unknown>) }
      : rawArgs;
  const parsed = webSearchArgs.safeParse(filled);
  if (!parsed.success) return { error: `Invalid arguments: ${z.prettifyError(parsed.error)}` };
  const { query: rawQuery, topic, start_date, max_results } = parsed.data;
  // Models still write `site:x.com` now and then; move those into the domain filter, where they work.
  const { query, domains } = splitSiteOperators(rawQuery, parsed.data.domains ?? []);
  if (!query.trim()) return { error: "Empty query." };
  if (!config.tavilyApiKey) return { query, error: "Search is unavailable: TAVILY_API_KEY is not set." };

  const opts: TavilySearchOptions = {
    searchDepth: config.searchDepth,
    topic: topic ?? "general",
    maxResults: Math.min(Math.max(Math.round(max_results ?? (domains.length ? DOMAIN_RESULTS : DEFAULT_RESULTS)), 1), MAX_RESULTS),
    // Several relevant passages per page; Tavily supports this only for advanced search.
    ...(config.searchDepth === "advanced" ? { chunksPerSource: 3 } : {}),
    includeAnswer: false,
    includeRawContent: false,
    includeImages: false,
    timeout: TIMEOUT_MS / 1000,
  };
  if (start_date && ISO_DATE.test(start_date)) opts.startDate = start_date;
  if (domains.length) opts.includeDomains = domains;

  try {
    const res = await getClient().search(query, opts);
    const results = res.results.map((r) => {
      const published = normalizeDate(r.publishedDate);
      const title = r.title?.trim() || r.url;
      const content = compactContent(r.content ?? "", domains.length ? DOMAIN_CONTENT_CHARS : CONTENT_CHARS);
      return { n: sources.add({ title, url: r.url, published }), title, url: r.url, published, content };
    });
    return { query, results };
  } catch (err) {
    return { query, error: errorMessage(err) };
  }
}

/** Serialized form sent back to the model as the function_call_output. */
export function formatSearchOutput(out: SearchOutput): string {
  if ("error" in out) return JSON.stringify(out);
  if (!out.results.length) return JSON.stringify({ query: out.query, results: [], note: "No results. Try a broader query or drop start_date." });
  return JSON.stringify(out);
}
