/**
 * App configuration, read once from environment variables (and `.env`, if present).
 * Every other module imports `config` from here instead of reading `process.env` itself.
 */

// Load .env without a dependency (Node >= 21.7). A missing file is fine: env may come from the shell.
try {
  process.loadEnvFile();
} catch {
  // No .env file.
}

const REASONING_EFFORTS = ["none", "minimal", "low", "medium", "high"] as const;
const SEARCH_DEPTHS = ["basic", "advanced"] as const;

export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];
export type SearchDepth = (typeof SEARCH_DEPTHS)[number];

// ── Readers: each returns the fallback when the variable is missing or invalid ──

function readEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function readString(name: string, fallback: string): string {
  return readEnv(name) ?? fallback;
}

function readPositiveInt(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

/** An ISO date/time as epoch milliseconds, or undefined when missing or unparseable. */
function readTimestamp(name: string): number | undefined {
  const time = Date.parse(readEnv(name) ?? "");
  return Number.isNaN(time) ? undefined : time;
}

function readEnum<T extends string>(name: string, allowed: readonly T[], fallback: T): T {
  const value = readEnv(name);
  return allowed.includes(value as T) ? (value as T) : fallback;
}

export const config = {
  port: readPositiveInt("PORT", 3000),
  /** Loopback by default: there is no login, so the app must not be reachable from the network. */
  host: readString("HOST", "127.0.0.1"),
  /** MINIMI_NOW: a fixed "current time" for demos and evals over imported history. Normally unset. */
  fixedNow: readTimestamp("MINIMI_NOW"),
  dbPath: readString("DB_PATH", "./data/minimi.db"),

  openaiApiKey: readString("OPENAI_API_KEY", ""),
  tavilyApiKey: readString("TAVILY_API_KEY", ""),

  /** Main chat model. gpt-6.1-sol balances quality and latency; gpt-6-astra is the flagship. */
  chatModel: readString("OPENAI_MODEL", "gpt-6.1-sol"),
  reasoningEffort: readEnum("OPENAI_REASONING_EFFORT", REASONING_EFFORTS, "low"),
  /** Cheap model for off-critical-path work: fact extraction, conversation titles. */
  extractModel: readString("OPENAI_EXTRACT_MODEL", "gpt-6-luna"),
  /**
   * Not configurable on purpose: stored vectors are only comparable with vectors from the same
   * model, and the similarity thresholds in memory/ranking.ts were measured for this one.
   */
  embeddingModel: "text-embedding-3-small",

  /** Tavily search depth: "advanced" ranks and extracts better, "basic" is faster. */
  searchDepth: readEnum("SEARCH_DEPTH", SEARCH_DEPTHS, "advanced"),

  /** Hard cap on web searches in one user turn (keeps latency and cost bounded). */
  maxSearchesPerTurn: 6,
  /** Character budget for the injected <memory> block (~4 chars per token). */
  memoryCharBudget: 14_000,
} as const;

/** Required keys that are not set, so the server can warn on startup and the UI can show a clear error. */
export function missingKeys(): string[] {
  const missing: string[] = [];
  if (!config.openaiApiKey) missing.push("OPENAI_API_KEY");
  if (!config.tavilyApiKey) missing.push("TAVILY_API_KEY");
  return missing;
}
