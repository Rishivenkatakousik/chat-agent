// Load .env without a dependency (Node >= 21.7). A missing file is fine: env may come from the shell.
try {
  process.loadEnvFile();
} catch {
  /* no .env file */
}

export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high";
export type SearchDepth = "basic" | "advanced";

function str(name: string, fallback: string): string {
  const v = process.env[name]?.trim();
  return v ? v : fallback;
}

function int(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

function effort(name: string, fallback: ReasoningEffort): ReasoningEffort {
  const v = process.env[name]?.trim();
  return v === "none" || v === "minimal" || v === "low" || v === "medium" || v === "high" ? v : fallback;
}

function depth(name: string, fallback: SearchDepth): SearchDepth {
  const v = process.env[name]?.trim();
  return v === "basic" || v === "advanced" ? v : fallback;
}

export const config = {
  port: int("PORT", 3000),
  dbPath: str("DB_PATH", "./data/minimi.db"),

  openaiApiKey: process.env.OPENAI_API_KEY?.trim() ?? "",
  tavilyApiKey: process.env.TAVILY_API_KEY?.trim() ?? "",

  /** Main chat model. gpt-6.1-sol balances quality and latency; gpt-6-astra is the flagship. */
  chatModel: str("OPENAI_MODEL", "gpt-6.1-sol"),
  reasoningEffort: effort("OPENAI_REASONING_EFFORT", "low"),
  /** Cheap model for off-critical-path work: fact extraction, conversation titles. */
  extractModel: str("OPENAI_EXTRACT_MODEL", "gpt-6-luna"),
  embeddingModel: str("OPENAI_EMBEDDING_MODEL", "text-embedding-3-small"),

  /** Tavily search depth: "advanced" ranks and extracts better, "basic" is faster. */
  searchDepth: depth("SEARCH_DEPTH", "advanced"),

  /** Hard cap on web searches in one user turn (keeps latency and cost bounded). */
  maxSearchesPerTurn: 6,
  /** Character budget for the injected <memory> block (~4 chars per token). */
  memoryCharBudget: 14_000,
} as const;

/** Missing required keys, so the server can warn on startup and the UI can show a clear error. */
export function missingKeys(): string[] {
  const missing: string[] = [];
  if (!config.openaiApiKey) missing.push("OPENAI_API_KEY");
  if (!config.tavilyApiKey) missing.push("TAVILY_API_KEY");
  return missing;
}
