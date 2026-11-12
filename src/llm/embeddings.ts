/**
 * Text embeddings (OpenAI text-embedding-3-small) for semantic memory recall.
 * Embedding is always optional: every function returns null instead of throwing, so recall
 * falls back to dates and keywords when no key is set or the API is down.
 */
import { config } from "../config.js";
import { getOpenAI } from "./openai-client.js";

/** Returns a vector for `text`, or null when embeddings are unavailable (no key, error, timeout). */
export type Embedder = (text: string, signal?: AbortSignal) => Promise<Float32Array | null>;

/** Embeds several texts in one request; the result has one entry (or null) per input. */
export type EmbedMany = (texts: string[], timeoutMs?: number) => Promise<(Float32Array | null)[]>;

const MAX_INPUT_CHARS = 8_000;
const BATCH_TIMEOUT_MS = 10_000;
/** Query embedding runs on the critical path (before the model starts), so it gets a short timeout. */
const QUERY_TIMEOUT_MS = 2_500;

export const embedMany: EmbedMany = async (texts, timeoutMs = BATCH_TIMEOUT_MS) => {
  const nothing = texts.map(() => null);
  if (!config.openaiApiKey || texts.length === 0) return nothing;

  try {
    const response = await getOpenAI().embeddings.create(
      { model: config.embeddingModel, input: texts.map((text) => text.slice(0, MAX_INPUT_CHARS)) },
      { signal: AbortSignal.timeout(timeoutMs), maxRetries: 1 },
    );
    const vectors: (Float32Array | null)[] = [...nothing];
    for (const item of response.data) {
      vectors[item.index] = Float32Array.from(item.embedding);
    }
    return vectors;
  } catch (error) {
    console.warn(`[embed] failed: ${error instanceof Error ? error.message : error}`);
    return nothing;
  }
};

/** Query-time embedder used by recall. Recall still works on dates and keywords without it. */
export const embedQuery: Embedder = async (text, signal) => {
  if (!config.openaiApiKey || signal?.aborted) return null;
  const [vector] = await embedMany([text], QUERY_TIMEOUT_MS);
  return vector ?? null;
};

/** Cosine similarity of two vectors: 1 = same direction, 0 = unrelated. */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;

  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  return normA && normB ? dot / Math.sqrt(normA * normB) : 0;
}
