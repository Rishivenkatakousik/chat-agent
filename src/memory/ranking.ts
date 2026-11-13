/**
 * Ranking for recall: similarity thresholds, semantic (embedding) hits, and reciprocal rank
 * fusion, which merges a keyword-ranked list and a meaning-ranked list into one.
 */
import { cosineSimilarity } from "../llm/embeddings.js";
import type { Database } from "../storage/database.js";

/**
 * Cosine thresholds for text-embedding-3-small, measured on real queries: the right past message
 * scored 0.37–0.51 (typos and paraphrases included), unrelated ones 0–0.17, a related-but-different
 * topic up to ~0.39. A message that refers to the past ("I asked", "one day") uses the lower bar.
 */
export const SIMILARITY_IN_WINDOW = 0.3;
export const SIMILARITY_GLOBAL = 0.33;
export const SIMILARITY_STRONG = 0.45;
/**
 * With embeddings available, a keyword match must also be at least loosely related in meaning. In a
 * small history every word looks rare, so "release" or "company" alone matched unrelated chats
 * (measured: those scored 0.23–0.28; true matches with one shared word scored 0.37+).
 */
export const SIMILARITY_CORROBORATE = 0.3;

/** The usual RRF constant: damps the weight of the very top ranks. */
const RRF_K = 60;
const DEFAULT_LIMIT = 20;

export interface VectorHit {
  id: number;
  similarity: number;
}

export interface FusedHit {
  id: number;
  /** Fused score; higher is better. */
  score: number;
  /** Cosine similarity when the hit came from the vector list, else 0. */
  similarity: number;
}

/** Cosine similarity of the query to every embedded message, by message id. Computed once per turn. */
export function similarityById(db: Database, queryVector: Float32Array): Map<number, number> {
  const similarities = new Map<number, number>();
  for (const row of db.messages.listEmbeddings()) {
    similarities.set(row.id, cosineSimilarity(queryVector, row.embedding));
  }
  return similarities;
}

/** Messages at or above `minSimilarity`, most similar first. */
export function topVectorHits(
  similarities: ReadonlyMap<number, number>,
  minSimilarity: number,
  exclude: ReadonlySet<number>,
  limit = DEFAULT_LIMIT,
): VectorHit[] {
  return [...similarities]
    .filter(([id, similarity]) => similarity >= minSimilarity && !exclude.has(id))
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([id, similarity]) => ({ id, similarity }));
}

/** Reciprocal rank fusion: each list adds 1 / (K + rank) to a message's score. */
export function reciprocalRankFusion(
  keywordRanked: readonly { id: number }[],
  vectorRanked: readonly VectorHit[],
): FusedHit[] {
  const hits = new Map<number, FusedHit>();
  const hitFor = (id: number): FusedHit => {
    let hit = hits.get(id);
    if (!hit) {
      hit = { id, score: 0, similarity: 0 };
      hits.set(id, hit);
    }
    return hit;
  };

  keywordRanked.forEach((message, rank) => {
    hitFor(message.id).score += 1 / (RRF_K + rank + 1);
  });
  vectorRanked.forEach((vectorHit, rank) => {
    const hit = hitFor(vectorHit.id);
    hit.score += 1 / (RRF_K + rank + 1);
    hit.similarity = vectorHit.similarity;
  });

  return [...hits.values()].sort((a, b) => b.score - a.score);
}
