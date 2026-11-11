import { config } from "../config.js";
import { openai } from "./turn.js";

/** Returns a vector for `text`, or null when embeddings are unavailable (no key, error, timeout). */
export type Embedder = (text: string, signal?: AbortSignal) => Promise<Float32Array | null>;

const MAX_INPUT_CHARS = 8_000;

/** Embeds several texts in one request. Returns null for all on failure. */
export async function embedMany(texts: string[], timeoutMs = 10_000): Promise<(Float32Array | null)[]> {
  if (!config.openaiApiKey || !texts.length) return texts.map(() => null);
  try {
    const res = await openai().embeddings.create(
      { model: config.embeddingModel, input: texts.map((t) => t.slice(0, MAX_INPUT_CHARS)) },
      { signal: AbortSignal.timeout(timeoutMs), maxRetries: 1 },
    );
    const out: (Float32Array | null)[] = texts.map(() => null);
    for (const d of res.data) out[d.index] = Float32Array.from(d.embedding);
    return out;
  } catch (err) {
    console.warn(`[embed] failed: ${err instanceof Error ? err.message : err}`);
    return texts.map(() => null);
  }
}

/**
 * Query-time embedder used by recall. Short timeout: it runs on the critical
 * path, and recall still works on dates and keywords without it.
 */
export const embedQuery: Embedder = async (text, signal) => {
  if (!config.openaiApiKey || signal?.aborted) return null;
  const [v] = await embedMany([text], 2_500);
  return v ?? null;
};

export function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}
