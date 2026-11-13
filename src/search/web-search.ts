/**
 * The agent's one tool: web search, backed by Tavily.
 *
 * - `webSearchTool` is the function definition the model sees (built from a zod schema).
 * - `webSearch()` runs one call: validates the arguments, calls Tavily, and compacts the results
 *   (title, url, published date, ~1,200 chars of the most relevant content), numbered per turn
 *   so the model can cite them as [n].
 */
import { tavily, type TavilyClient, type TavilySearchOptions } from "@tavily/core";
import type { FunctionTool } from "openai/resources/responses/responses";
import { z } from "zod";
import { config } from "../config.js";
import type { SourceRegistry } from "./sources.js";

// ── Tuning ──────────────────────────────────────────────────────────

const MAX_RESULTS = 8;
const DEFAULT_RESULTS = 5;
const CONTENT_CHARS = 1_200;
/**
 * Searches restricted to a vendor's own site return fewer, longer results: an official pricing
 * page's numbers rarely fit in a short snippet, and a missing number costs a whole extra model
 * round (~8s).
 */
const DOMAIN_RESULTS = 3;
const DOMAIN_CONTENT_CHARS = 2_400;
const MAX_DOMAINS = 5;
/** One slow search holds up the whole round (they are awaited together), so it gets cut off early. */
const TIMEOUT_MS = 10_000;

// ── Tool definition ─────────────────────────────────────────────────

// Strict-mode function schema: every field is required, optional ones are nullable.
export const webSearchArgs = z.strictObject({
  query: z
    .string()
    .describe(
      "A focused natural-language query naming the product, vendor or topic, e.g. 'Neon Postgres pricing plans'. No search operators (site:, quotes, OR): use `domains` to target a site.",
    ),
  topic: z
    .enum(["general", "news"])
    .nullable()
    .describe(
      "'news' for recent events, announcements and anything 'since' a date; 'general' (default) for docs, pricing pages and reference facts.",
    ),
  start_date: z
    .string()
    .nullable()
    .describe(
      "YYYY-MM-DD. Only return pages published on or after this date. Use for 'what changed since X'. Leave null for pricing or docs pages, which often have no publish date and would be filtered out.",
    ),
  domains: z
    .array(z.string())
    .nullable()
    .describe(
      "Restrict results to these sites, e.g. ['neon.com'] for Neon's own pricing page. Up to 5. Use for official pricing, docs and changelogs; null to search everywhere.",
    ),
  // Plain number (no .int()/.min()): keeps the schema simple for strict mode; clamped in code.
  max_results: z
    .number()
    .nullable()
    .describe(`Number of results, 1-${MAX_RESULTS}. Default ${DEFAULT_RESULTS}.`),
});

export type WebSearchArgs = z.infer<typeof webSearchArgs>;

const { $schema: _ignored, ...parameters } = z.toJSONSchema(webSearchArgs, {
  target: "draft-7",
}) as Record<string, unknown>;

export const webSearchTool: FunctionTool = {
  type: "function",
  name: "web_search",
  description:
    "Search the web for current information. Returns numbered results with title, url, published date and relevant page content. " +
    "Run several searches in parallel when comparing multiple products. Cite results by their number, e.g. [3].",
  parameters,
  strict: true,
};

// ── Results ─────────────────────────────────────────────────────────

export interface SearchResult {
  /** Citation number, unique within the turn. */
  n: number;
  title: string;
  url: string;
  published: string | null;
  content: string;
}

export type SearchOutput = { query: string; results: SearchResult[] } | { query?: string; error: string };

/** Signature of `webSearch`; tests swap in a fake. */
export type WebSearchFunction = (rawArgs: unknown, sources: SourceRegistry) => Promise<SearchOutput>;

/** Serialized form sent back to the model as the function_call_output. */
export function formatSearchOutput(output: SearchOutput): string {
  if ("results" in output && output.results.length === 0) {
    return JSON.stringify({
      query: output.query,
      results: [],
      note: "No results. A start_date or domains filter may have been too narrow.",
    });
  }
  return JSON.stringify(output);
}

// ── Argument clean-up ───────────────────────────────────────────────

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** "neon.com", "https://www.neon.com/pricing" → "neon.com"; null if it isn't a plausible host. */
function toDomain(text: string): string | null {
  const host =
    text
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, "")
      .replace(/^www\./, "")
      .split(/[/?#\s]/)[0] ?? "";
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host) ? host : null;
}

/**
 * Models still write `site:x.com` now and then (or the `site.x.com` slip). This moves those into
 * the domain filter, where they work, and merges them with `domains`.
 */
export function splitSiteOperators(query: string, domains: string[]): { query: string; domains: string[] } {
  const fromQuery: string[] = [];
  const cleanedQuery = query
    .replace(/(?:^|\s)site[:.]\s*(\S+)/gi, (operator, target: string) => {
      const domain = toDomain(target);
      if (!domain) return operator;
      fromQuery.push(domain);
      return " ";
    })
    .replace(/\s+/g, " ")
    .trim();

  const allDomains = [...domains.map(toDomain), ...fromQuery].filter((domain): domain is string =>
    Boolean(domain),
  );
  return { query: cleanedQuery, domains: [...new Set(allDomains)].slice(0, MAX_DOMAINS) };
}

/** Strict mode should always send every field, but a missing optional one is treated as null. */
function parseArgs(rawArgs: unknown) {
  const withDefaults =
    rawArgs && typeof rawArgs === "object"
      ? { topic: null, start_date: null, domains: null, max_results: null, ...rawArgs }
      : rawArgs;
  return webSearchArgs.safeParse(withDefaults);
}

function resultCount(requested: number | null, hasDomains: boolean): number {
  const count = Math.round(requested ?? (hasDomains ? DOMAIN_RESULTS : DEFAULT_RESULTS));
  return Math.min(Math.max(count, 1), MAX_RESULTS);
}

/** Collapses whitespace and cuts at a word boundary near `max` characters. */
function compactContent(text: string, max: number): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length <= max) return collapsed;

  const cut = collapsed.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  return `${cut.slice(0, lastSpace > max * 0.8 ? lastSpace : max)}…`;
}

/** "Tue, 03 Nov 2026 10:00:00 GMT" → "2026-11-03"; null when missing or unparseable. */
function normalizeDate(text: string | undefined | null): string | null {
  if (!text) return null;
  const time = Date.parse(text);
  return Number.isNaN(time) ? null : new Date(time).toISOString().slice(0, 10);
}

// ── Tavily ──────────────────────────────────────────────────────────

let client: TavilyClient | undefined;

function getTavily(): TavilyClient {
  client ??= tavily({ apiKey: config.tavilyApiKey });
  return client;
}

/** What went wrong, for the model. Whether it may search again is the agent loop's decision. */
function describeSearchError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/401|unauthori[sz]ed|invalid api key/i.test(message)) {
    return "Search is unavailable: the Tavily API key was rejected.";
  }
  if (/429|rate limit|usage limit|exceeded/i.test(message)) {
    return "Search is rate-limited right now.";
  }
  if (/timeout|timed out|ETIMEDOUT|aborted/i.test(message)) {
    return "The search timed out.";
  }
  return `Search failed: ${message.slice(0, 200)}`;
}

function buildTavilyOptions(args: WebSearchArgs, domains: string[]): TavilySearchOptions {
  const options: TavilySearchOptions = {
    searchDepth: config.searchDepth,
    topic: args.topic ?? "general",
    maxResults: resultCount(args.max_results, domains.length > 0),
    includeAnswer: false,
    includeRawContent: false,
    includeImages: false,
    timeout: TIMEOUT_MS / 1000,
  };
  // Several relevant passages per page; Tavily supports this only for advanced search.
  if (config.searchDepth === "advanced") options.chunksPerSource = 3;
  if (args.start_date && ISO_DATE.test(args.start_date)) options.startDate = args.start_date;
  if (domains.length > 0) options.includeDomains = domains;
  return options;
}

/**
 * Runs one web_search call. Never throws: failures come back as `{ error }` so the model can
 * retry with a different query or tell the user search is unavailable.
 */
export const webSearch: WebSearchFunction = async (rawArgs, sources) => {
  const parsed = parseArgs(rawArgs);
  if (!parsed.success) return { error: `Invalid arguments: ${z.prettifyError(parsed.error)}` };

  const { query, domains } = splitSiteOperators(parsed.data.query, parsed.data.domains ?? []);
  if (!query.trim()) return { error: "Empty query." };
  if (!config.tavilyApiKey) return { query, error: "Search is unavailable: TAVILY_API_KEY is not set." };

  const contentChars = domains.length > 0 ? DOMAIN_CONTENT_CHARS : CONTENT_CHARS;
  try {
    const response = await getTavily().search(query, buildTavilyOptions(parsed.data, domains));
    // Only web pages become sources: a result URL ends up as a link in the UI.
    const pages = response.results.filter((result) => /^https?:\/\//i.test(result.url));
    const results = pages.map((result): SearchResult => {
      const title = result.title?.trim() || result.url;
      const published = normalizeDate(result.publishedDate);
      const n = sources.add({ title, url: result.url, published });
      const content = compactContent(result.content ?? "", contentChars);
      return { n, title, url: result.url, published, content };
    });
    return { query, results };
  } catch (error) {
    return { query, error: describeSearchError(error) };
  }
};
