/**
 * Memory recall: runs in code before the model (not as a tool), so it costs no extra model
 * round trip and behaves the same every time.
 *
 * For one user message it finds the relevant past exchanges and facts in three passes:
 *   1. Date windows   ("last Tuesday" → messages on those days, topic matches first)
 *   2. Whole history  (keyword search + embedding similarity, fused; strict thresholds)
 *   3. Facts          (structured facts matched by name, when the user refers to the past)
 * Then expands hits into full question/answer exchanges and renders the <memory> block, with
 * honest notes about dates that have no conversations.
 */
import { config } from "../config.js";
import type { Embedder } from "../llm/embeddings.js";
import type { Database } from "../storage/database.js";
import { toFtsQuery } from "../storage/sql.js";
import type { Fact, LabeledWindow, Message, TimeRef } from "../types.js";
import {
  extractKeywords,
  findDistinctiveKeywords,
  hasMemoryCue,
  keywordMatchQuality,
} from "./query-analysis.js";
import {
  reciprocalRankFusion,
  SIMILARITY_CORROBORATE,
  SIMILARITY_GLOBAL,
  SIMILARITY_IN_WINDOW,
  SIMILARITY_STRONG,
  similarityById,
  topVectorHits,
} from "./ranking.js";
import { clip, renderMemory } from "./render-memory.js";

export interface RecallInput {
  db: Database;
  message: string;
  timezone: string;
  timeRefs: TimeRef[];
  /** Message ids the model already sees (recent history, the current question). */
  exclude?: ReadonlySet<number>;
  /** Query embedder; omit (or let it return null) to recall on dates and keywords only. */
  embed?: Embedder;
  signal?: AbortSignal;
  charBudget?: number;
}

/** Why an exchange was recalled. Also its priority: earlier in this list wins. */
export type RecallReason = "date+topic" | "date" | "topic";

export interface RecalledExchange {
  messages: Message[];
  reason: RecallReason;
  conversationTitle: string | null;
}

export interface RecallResult {
  /** Contents for the <memory> block. */
  memory: string;
  exchanges: RecalledExchange[];
  facts: Fact[];
  notes: string[];
  stats: { keywords: string[]; cue: boolean; usedEmbeddings: boolean; ms: number };
}

// ── Tuning ──────────────────────────────────────────────────────────

const PRIORITY: Record<RecallReason, number> = { "date+topic": 0, date: 1, topic: 2 };
const SEARCH_LIMIT = 20;
const MAX_WINDOW_EXCHANGES = 8;
/** Whole-history hits taken per message: more when the user clearly refers to the past. */
const MAX_HISTORY_HITS = 2;
const MAX_HISTORY_HITS_WITH_CUE = 4;
const FACT_SEARCH_LIMIT = 15;
/** A matched fact also brings back the exchange it came from, for at most this many exchanges. */
const MAX_FACT_SOURCE_EXCHANGES = 3;
const MAX_TOPICS_IN_NOTE = 3;

// ── Shared state of one recall ──────────────────────────────────────

/** Everything the passes need to know about the message, worked out once. */
interface Query {
  keywords: string[];
  /** FTS5 expression for the keywords; null when there are none. */
  match: string | null;
  /** The message refers to an earlier conversation ("I asked", "since"). */
  cue: boolean;
  /** Embedding of the message; null when embeddings are unavailable. */
  vector: Float32Array | null;
  /** Keywords that are rare in the history, so a single one is a real signal. */
  distinctive: ReadonlySet<string>;
}

/** Candidate messages found by the passes. A message keeps the highest-priority reason it was found for. */
class CandidateList {
  private readonly reasons = new Map<number, RecallReason>();
  readonly exclude: ReadonlySet<number>;

  constructor(exclude: ReadonlySet<number>) {
    this.exclude = exclude;
  }

  add(messageId: number, reason: RecallReason): void {
    if (this.exclude.has(messageId)) return;
    const previous = this.reasons.get(messageId);
    if (!previous || PRIORITY[reason] < PRIORITY[previous]) this.reasons.set(messageId, reason);
  }

  entries(): [number, RecallReason][] {
    return [...this.reasons];
  }
}

async function analyzeQuery(input: RecallInput): Promise<Query> {
  const { db, message, timeRefs } = input;
  const keywords = extractKeywords(message, timeRefs);

  // Every message is searched by meaning as well as by keywords: users rarely phrase a reference to
  // a past chat the way the code expects (typos, paraphrases). One embedding call (~0.5s) per turn,
  // skipped only when nothing has been embedded yet.
  const canEmbed = input.embed !== undefined && db.messages.hasEmbeddings();
  const vector = canEmbed ? await input.embed!(message, input.signal).catch(() => null) : null;

  return {
    keywords,
    match: toFtsQuery(keywords),
    cue: hasMemoryCue(message),
    vector,
    distinctive: findDistinctiveKeywords(db, keywords),
  };
}

// ── Pass 1: date windows ────────────────────────────────────────────

interface WindowSearch {
  window: LabeledWindow;
  /** Every message on that date (minus excluded ones). */
  messages: Message[];
  /** Topic matches among them, best first. */
  hits: { id: number }[];
}

function searchWindow(
  db: Database,
  window: LabeledWindow,
  query: Query,
  exclude: ReadonlySet<number>,
): WindowSearch {
  const messages = db.messages.listInWindow(window).filter((message) => !exclude.has(message.id));
  if (messages.length === 0) return { window, messages, hits: [] };

  const keywordHits = query.match
    ? db.messages.search(query.match, window, SEARCH_LIMIT).filter((message) => !exclude.has(message.id))
    : [];
  const vectorHits = query.vector
    ? topVectorHits(similarityById(db, query.vector, window), SIMILARITY_IN_WINDOW, exclude)
    : [];
  return { window, messages, hits: reciprocalRankFusion(keywordHits, vectorHits) };
}

/** Short description of a day's conversations, for "nothing about this topic" notes. */
function describeTopics(db: Database, messages: Message[]): string {
  const conversationIds = [...new Set(messages.map((message) => message.conversation_id))];
  const topics = conversationIds.slice(0, MAX_TOPICS_IN_NOTE).map((conversationId) => {
    const title = db.conversations.get(conversationId)?.title;
    if (title) return `"${title}"`;
    const question = messages.find(
      (message) => message.conversation_id === conversationId && message.role === "user",
    );
    return `"${clip(question?.text ?? "", 60)}"`;
  });

  const count = conversationIds.length;
  const more = count > MAX_TOPICS_IN_NOTE ? ", …" : "";
  return `${count} conversation${count === 1 ? "" : "s"} (${topics.join(", ")}${more})`;
}

/**
 * For each date the user mentioned: if any candidate date has topic matches, take those (and note
 * the dates that had other topics). If none match, take everything from the dates.
 */
function recallFromDateWindows(
  db: Database,
  timeRefs: TimeRef[],
  query: Query,
  candidates: CandidateList,
  notes: string[],
): void {
  for (const ref of timeRefs) {
    const searches = ref.windows.map((window) => searchWindow(db, window, query, candidates.exclude));
    const anyTopicMatch = searches.some((search) => search.hits.length > 0);

    for (const { window, messages, hits } of searches) {
      if (messages.length === 0) {
        notes.push(`No conversations found on ${window.label} ("${ref.phrase}").`);
        continue;
      }

      if (anyTopicMatch) {
        if (hits.length > 0) {
          for (const hit of hits.slice(0, MAX_WINDOW_EXCHANGES)) candidates.add(hit.id, "date+topic");
        } else {
          notes.push(
            `${window.label} ("${ref.phrase}"): ${describeTopics(db, messages)} — nothing about this topic.`,
          );
        }
        continue;
      }

      if (query.keywords.length > 0) {
        notes.push(
          `Nothing on ${window.label} matched the topic exactly; showing everything from that date.`,
        );
      }
      const questions = messages.filter((message) => message.role === "user");
      const shown = (questions.length > 0 ? questions : messages).slice(-MAX_WINDOW_EXCHANGES);
      for (const message of shown) candidates.add(message.id, "date");
    }
  }
}

// ── Pass 2: whole history ───────────────────────────────────────────

/**
 * Searches all past messages, but takes a hit only when the match is convincing: enough keyword
 * overlap that is also related in meaning, or a high similarity on its own. A memory cue
 * ("I asked", "one day") lowers both bars.
 */
function recallFromWholeHistory(db: Database, query: Query, candidates: CandidateList): void {
  if (!query.match && !query.vector) return;
  const { exclude } = candidates;

  const keywordHits = query.match
    ? db.messages.search(query.match, undefined, SEARCH_LIMIT).filter((message) => !exclude.has(message.id))
    : [];
  // Similarity to every embedded message: ranks semantic hits and corroborates keyword hits.
  const similarities = query.vector ? similarityById(db, query.vector) : new Map<number, number>();
  const vectorHits = topVectorHits(similarities, SIMILARITY_GLOBAL, exclude);

  const textById = new Map(keywordHits.map((message) => [message.id, message.text]));
  const missingIds = vectorHits.map((hit) => hit.id).filter((id) => !textById.has(id));
  for (const message of db.messages.getByIds(missingIds)) textById.set(message.id, message.text);

  const maxHits = query.cue ? MAX_HISTORY_HITS_WITH_CUE : MAX_HISTORY_HITS;
  const minKeywordQuality = query.cue ? 1 : 2;
  const minSimilarity = query.cue ? SIMILARITY_GLOBAL : SIMILARITY_STRONG;
  let taken = 0;

  for (const hit of reciprocalRankFusion(keywordHits, vectorHits)) {
    if (taken >= maxHits) break;

    const quality = keywordMatchQuality(query.keywords, query.distinctive, textById.get(hit.id) ?? "");
    // Undefined when the message has no embedding: then keywords alone decide.
    const similarity = similarities.get(hit.id);
    const keywordsMatch =
      quality >= minKeywordQuality && (similarity === undefined || similarity >= SIMILARITY_CORROBORATE);
    const meaningMatches = similarity !== undefined && similarity >= minSimilarity;
    if (!keywordsMatch && !meaningMatches) continue;

    candidates.add(hit.id, "topic");
    taken++;
  }
}

// ── Pass 3: facts ───────────────────────────────────────────────────

/**
 * Fact matches by name, when the user refers to the past. A matched fact also brings back the
 * exchange it came from, since its wording may share too few keywords to be found directly.
 */
function recallFromFacts(db: Database, timeRefs: TimeRef[], query: Query, candidates: CandidateList): Fact[] {
  if (!query.match || (!query.cue && timeRefs.length === 0)) return [];

  // Same bar as message recall: one common word ("pricing") doesn't pull in unrelated facts.
  const minQuality = query.keywords.length >= 2 ? 1.5 : 1;
  const matched: Fact[] = [];
  const sourceMessages = new Set<number>();

  for (const fact of db.facts.search(query.match, undefined, FACT_SEARCH_LIMIT)) {
    const messageId = fact.message_id;
    if (messageId != null && candidates.exclude.has(messageId)) continue;

    const factText = `${fact.entity} ${fact.attribute} ${fact.value}`;
    if (keywordMatchQuality(query.keywords, query.distinctive, factText) < minQuality) continue;
    matched.push(fact);

    const isNewSource = messageId != null && !sourceMessages.has(messageId);
    if (isNewSource && sourceMessages.size < MAX_FACT_SOURCE_EXCHANGES) {
      sourceMessages.add(messageId);
      candidates.add(messageId, "topic");
    }
  }
  return matched;
}

// ── Assembling the result ───────────────────────────────────────────

/** Turns candidate messages into full question/answer exchanges, deduplicated, ordered by priority then time. */
function expandToExchanges(db: Database, candidates: CandidateList): RecalledExchange[] {
  const byQuestionId = new Map<number, { messages: Message[]; reason: RecallReason }>();

  for (const [messageId, reason] of candidates.entries()) {
    const messages = db.messages
      .getExchange(messageId)
      .filter((message) => !candidates.exclude.has(message.id));
    if (messages.length === 0) continue;

    const key = messages[0]!.id;
    const previous = byQuestionId.get(key);
    if (!previous || PRIORITY[reason] < PRIORITY[previous.reason])
      byQuestionId.set(key, { messages, reason });
  }

  const titles = new Map<string, string | null>();
  const titleOf = (conversationId: string): string | null => {
    if (!titles.has(conversationId))
      titles.set(conversationId, db.conversations.get(conversationId)?.title ?? null);
    return titles.get(conversationId)!;
  };

  return [...byQuestionId.values()]
    .sort(
      (a, b) =>
        PRIORITY[a.reason] - PRIORITY[b.reason] || a.messages[0]!.created_at - b.messages[0]!.created_at,
    )
    .map((exchange) => ({ ...exchange, conversationTitle: titleOf(exchange.messages[0]!.conversation_id) }));
}

/** Facts recorded with the recalled answers, plus the facts matched by name. Oldest first. */
function collectFacts(db: Database, exchanges: RecalledExchange[], matchedFacts: Fact[]): Fact[] {
  const messageIds = exchanges.flatMap((exchange) => exchange.messages.map((message) => message.id));
  const byId = new Map<number, Fact>();
  for (const fact of db.facts.listForMessages(messageIds)) byId.set(fact.id, fact);
  for (const fact of matchedFacts) byId.set(fact.id, fact);
  return [...byId.values()].sort((a, b) => a.observed_at - b.observed_at || a.id - b.id);
}

// ── Entry point ─────────────────────────────────────────────────────

export async function recall(input: RecallInput): Promise<RecallResult> {
  const startedAt = performance.now();
  const { db, timeRefs } = input;

  const query = await analyzeQuery(input);
  const candidates = new CandidateList(input.exclude ?? new Set());
  const notes: string[] = [];

  recallFromDateWindows(db, timeRefs, query, candidates, notes);
  recallFromWholeHistory(db, query, candidates);
  const matchedFacts = recallFromFacts(db, timeRefs, query, candidates);

  const exchanges = expandToExchanges(db, candidates);
  const facts = collectFacts(db, exchanges, matchedFacts);
  const { text, included } = renderMemory({
    exchanges,
    facts,
    notes,
    timeZone: input.timezone,
    budget: input.charBudget ?? config.memoryCharBudget,
  });

  return {
    memory: text,
    exchanges: included,
    facts,
    notes,
    stats: {
      keywords: query.keywords,
      cue: query.cue,
      usedEmbeddings: query.vector !== null,
      ms: Math.round(performance.now() - startedAt),
    },
  };
}
