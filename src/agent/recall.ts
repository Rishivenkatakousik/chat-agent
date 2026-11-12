import { config } from "../config.js";
import { toFtsQuery, type Db, type Fact, type Message, type TimeWindow } from "../db.js";
import { cosine, type Embedder } from "./embed.js";
import { formatDateTime, formatDay, type LabeledWindow, type TimeRef } from "./time.js";

/**
 * Memory recall, run in code before the model (not as a tool): date windows
 * from the time resolver, keyword search (FTS5/BM25) and embedding similarity,
 * fused with reciprocal rank fusion. The output is rendered into the
 * <memory> block of the turn's context, with honest notes about dates that
 * have no conversations.
 */

export interface RecallInput {
  db: Db;
  message: string;
  timezone: string;
  timeRefs: TimeRef[];
  /** Message ids the model already sees (recent history, the current question). */
  exclude?: ReadonlySet<number>;
  /** Query embedder; omit or return null to recall on dates and keywords only. */
  embed?: Embedder;
  signal?: AbortSignal;
  charBudget?: number;
}

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

// ── Query analysis ──────────────────────────────────────────────────

const STOPWORDS = new Set(
  `a about above after again against all am an and any are aren't as at be because been before being below between both but by
  can can't could did didn't do does doesn't doing don't down during each few for from further had hadn't has hasn't have haven't
  having he her here hers herself him himself his how i i'd i'll i'm i've if in into is isn't it it's its itself let's me more most
  my myself no nor not of off on once only or other ought our ours ourselves out over own same she should so some such than that
  that's the their theirs them themselves then there there's these they this those through to too under until up very was wasn't
  we we'd we'll we're we've were weren't what what's when where which while who whom why will with won't would you you'd you'll
  you're you've your yours yourself yourselves
  ask asked asking tell told say said discuss discussed talk talked mention mentioned remember recall question questions answer
  anything something everything thing things still since now currently current anymore change changed changes changing update
  updated updates new latest correct right true wrong valid accurate check recheck verify please thanks hey hi hello also
  just like know want need get got look looked good better best ok okay yes yeah much many lot lots way time times us
  today yesterday tomorrow ago last past next earlier later week weeks month months year years day days morning afternoon evening
  monday tuesday wednesday thursday friday saturday sunday
  january february march april may june july august september october november december
  jan feb mar apr jun jul aug sep sept oct nov dec
  one give gave date dates exact u ur pls plz ya kindly sure
  pick picked chose choose chosen decide decided plan planned research researched speak spoke chat chatted
  suggest suggested recommend recommended`.split(/\s+/),
);

/** Phrases that signal the user is referring to an earlier conversation. */
const PAST_VERB = "(?:ask|asked|discuss|discussed|talk|talked|shortlist|shortlisted|compare|compared|chose|choose|pick|picked|decide|decided|say|said|mention|mentioned|look|looked|research|researched|plan|planned|went over|go over|speak|spoke|chat|chatted)";
const MEMORY_CUE = new RegExp(
  [
    // "I asked", "we have discussed", "I've already asked", "we had once talked"
    `\\b(?:i|we)(?:'ve|'d)?(?:\\s+(?:have|had|did|already|once|ever|previously|just|also|have already|had once)){0,2}\\s+${PAST_VERB}\\b`,
    // "did I ask", "have we discussed", "when did we talk"
    `\\b(?:did|have|had)\\s+(?:i|we)\\s+(?:ever\\s+|already\\s+)?${PAST_VERB}\\b`,
    // "you said", "you once suggested", "you have told me"
    `\\byou(?:'ve)?(?:\\s+(?:have|had|once|already|just))?\\s+(?:said|told|suggested|recommended|mentioned|found|quoted|listed|gave|planned|answered|replied)\\b`,
    `\\b(?:last time|earlier|previously|remember|recall|again|still|since|changed|any changes|one day|the other day|some time ago|a while (?:ago|back)|our (?:chat|conversation|discussion|talk)|that (?:list|chat|conversation)|the list|shortlist|history)\\b`,
  ].join("|"),
  "i",
);

/** Content words of the message, minus stopwords, time words and the resolved time phrases. */
export function extractKeywords(message: string, timeRefs: TimeRef[] = []): string[] {
  let text = message.toLowerCase();
  for (const r of timeRefs) text = text.replace(r.phrase.toLowerCase(), " ");
  const words = text.match(/[\p{L}\p{N}][\p{L}\p{N}+#.\-']*[\p{L}\p{N}+#]|[\p{L}]/gu) ?? [];
  const out: string[] = [];
  // "next.js" and "asp.net" stay whole; "lisdon.can" (a missing space) becomes "lisdon" + "can".
  const parts = words.flatMap((w) => (/\.(?:js|ts|net|io|ai|py|rb|go|sh)$/.test(w) || !w.includes(".") ? [w] : w.split(".")));
  for (let w of parts) {
    w = w.replace(/'s$/, "");
    if (w.length < 2 || STOPWORDS.has(w)) continue;
    if (/^\d{1,4}(?:st|nd|rd|th)?$/.test(w)) continue; // bare numbers and ordinals are mostly dates or counts
    if (!out.includes(w)) out.push(w);
  }
  return out.slice(0, 12);
}

export function hasMemoryCue(message: string): boolean {
  return MEMORY_CUE.test(message);
}

/** Crude stem for coverage checks (FTS itself uses the porter stemmer). */
function stem(w: string): string {
  return w.replace(/(?:ing|edly|ed|es|s|ly)$/, "").slice(0, 7);
}

/** Whether a keyword occurs in the text (matching at word starts, so "pick" doesn't match "topic"). */
function contains(text: string, keyword: string): boolean {
  const s = stem(keyword).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[^\\p{L}\\p{N}])${s}`, "u").test(text.toLowerCase());
}

/**
 * Keyword match quality: a distinctive keyword counts 1, a common one 0.5. So "weekend" alone
 * (one conversation) is a real signal, while "pricing" (everywhere) needs a second word with it.
 */
function quality(keywords: string[], distinctive: ReadonlySet<string>, text: string): number {
  return keywords.reduce((q, k) => (contains(text, k) ? q + (distinctive.has(k) ? 1 : 0.5) : q), 0);
}

// ── Ranking ─────────────────────────────────────────────────────────

const RRF_K = 60;
/**
 * Cosine thresholds for text-embedding-3-small, measured on real queries: the right past message
 * scored 0.37–0.51 (typos and paraphrases included), unrelated ones 0–0.17, a related-but-different
 * topic up to ~0.39. A message that refers to the past ("I asked", "one day") uses the lower bar.
 */
const VEC_IN_WINDOW = 0.3;
const VEC_GLOBAL = 0.33;
const VEC_STRONG = 0.45;
/**
 * With embeddings available, a keyword match must also be at least loosely related in meaning. In a
 * small history every word looks rare, so "release" or "company" alone matched unrelated chats
 * (measured: those scored 0.23–0.28; true matches with one shared word scored 0.37+).
 */
const VEC_CORROBORATE = 0.3;
/** A keyword is distinctive when it occurs in at most this share of all messages ("weekend" yes, "pricing" no). */
const DISTINCTIVE_SHARE = 0.25;

interface Hit {
  id: number;
  score: number;
  cos: number;
}

/** Reciprocal rank fusion of a BM25-ranked list and a cosine-ranked list. */
function fuse(fts: { id: number }[], vec: { id: number; cos: number }[]): Hit[] {
  const hits = new Map<number, Hit>();
  fts.forEach((m, i) => {
    const h = hits.get(m.id) ?? { id: m.id, score: 0, cos: 0 };
    h.score += 1 / (RRF_K + i + 1);
    hits.set(m.id, h);
  });
  vec.forEach((v, i) => {
    const h = hits.get(v.id) ?? { id: v.id, score: 0, cos: 0 };
    h.score += 1 / (RRF_K + i + 1);
    h.cos = v.cos;
    hits.set(v.id, h);
  });
  return [...hits.values()].sort((a, b) => b.score - a.score);
}

function vectorHits(db: Db, q: Float32Array | null, window: TimeWindow | undefined, min: number, limit = 20) {
  if (!q) return [];
  return db
    .allEmbeddings(window)
    .map((r) => ({ id: r.id, cos: cosine(q, r.embedding) }))
    .filter((r) => r.cos >= min)
    .sort((a, b) => b.cos - a.cos)
    .slice(0, limit);
}

// ── Recall ──────────────────────────────────────────────────────────

const PRIORITY: Record<RecallReason, number> = { "date+topic": 0, date: 1, topic: 2 };
const MAX_WINDOW_EXCHANGES = 8;

export async function recall(input: RecallInput): Promise<RecallResult> {
  const t0 = performance.now();
  const { db, message, timezone, timeRefs } = input;
  const exclude = input.exclude ?? new Set<number>();
  const keywords = extractKeywords(message, timeRefs);
  const cue = hasMemoryCue(message);
  const match = toFtsQuery(keywords);

  // Every message is searched by meaning as well as by keywords: users rarely phrase a reference to a
  // past chat the way the code expects ("one day I have discussed…", typos, paraphrases). One embedding
  // call (~0.5s) per turn, skipped only when nothing has been embedded yet.
  const qvec = input.embed && db.hasEmbeddings() ? await input.embed(message, input.signal).catch(() => null) : null;

  // Keyword rarity across the whole history decides how much a single matching word counts.
  const total = db.countMessages();
  const distinctive = new Set(
    keywords.filter((k) => {
      const q = toFtsQuery([k]);
      const df = q ? db.countMatches(q) : 0;
      return df > 0 && df <= Math.max(1, total * DISTINCTIVE_SHARE);
    }),
  );

  const notes: string[] = [];
  const picked = new Map<number, { anchor: number; reason: RecallReason; score: number }>();
  const pick = (id: number, reason: RecallReason, score: number) => {
    if (exclude.has(id)) return;
    const prev = picked.get(id);
    if (!prev || PRIORITY[reason] < PRIORITY[prev.reason]) picked.set(id, { anchor: id, reason, score });
  };

  // (a) Date windows: topic hits inside the window first; the whole window only if nothing matches.
  for (const ref of timeRefs) {
    const perWindow = ref.windows.map((w) => {
      const all = db.messagesInRange(w.start, w.end).filter((m) => !exclude.has(m.id));
      const fts = match && all.length ? db.searchMessages(match, w, 20).filter((m) => !exclude.has(m.id)) : [];
      const vec = all.length ? vectorHits(db, qvec, w, VEC_IN_WINDOW).filter((v) => !exclude.has(v.id)) : [];
      return { w, all, hits: fuse(fts, vec) };
    });

    const anyHits = perWindow.some((p) => p.hits.length);
    for (const { w, all, hits } of perWindow) {
      if (!all.length) {
        notes.push(`No conversations found on ${w.label} ("${ref.phrase}").`);
        continue;
      }
      if (anyHits) {
        if (hits.length) for (const h of hits.slice(0, MAX_WINDOW_EXCHANGES)) pick(h.id, "date+topic", h.score);
        else notes.push(`${w.label} ("${ref.phrase}"): ${describeTopics(db, all)} — nothing about this topic.`);
      } else {
        if (keywords.length) notes.push(`Nothing on ${w.label} matched the topic exactly; showing everything from that date.`);
        const users = all.filter((m) => m.role === "user");
        for (const m of (users.length ? users : all).slice(-MAX_WINDOW_EXCHANGES)) pick(m.id, "date", 0);
      }
    }
  }

  // (b) Whole history: only when the message points at the past, or the match is strong.
  if (match || qvec) {
    const fts = match ? db.searchMessages(match, undefined, 20).filter((m) => !exclude.has(m.id)) : [];
    // Similarity to every embedded message: ranks semantic hits and corroborates keyword hits.
    const cosById = new Map(qvec ? db.allEmbeddings().map((r) => [r.id, cosine(qvec, r.embedding)] as const) : []);
    const vec = [...cosById]
      .filter(([id, cos]) => cos >= VEC_GLOBAL && !exclude.has(id))
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([id, cos]) => ({ id, cos }));
    const text = new Map(fts.map((m) => [m.id, m.text]));
    const missing = vec.filter((v) => !text.has(v.id)).map((v) => v.id);
    for (const m of db.getMessagesByIds(missing)) text.set(m.id, m.text);

    let taken = 0;
    for (const h of fuse(fts, vec)) {
      if (taken >= (cue ? 4 : 2)) break;
      const q = quality(keywords, distinctive, text.get(h.id) ?? "");
      const cos = cosById.get(h.id);
      // A cue ("I asked", "one day") lowers the bar. Keywords count only if the meaning is at least loosely
      // related too, whenever that can be measured (the message has an embedding); otherwise keywords alone.
      const keywordOk = (cue ? q >= 1 : q >= 2) && (cos === undefined || cos >= VEC_CORROBORATE);
      const semanticOk = cos !== undefined && cos >= (cue ? VEC_GLOBAL : VEC_STRONG);
      const ok = keywordOk || semanticOk;
      if (!ok) continue;
      pick(h.id, "topic", h.score);
      taken++;
    }
  }

  // Fact matches by name, when the user refers to the past. A matched fact also brings back the exchange
  // it came from (a few at most), since its wording may share too few keywords to be found directly.
  const factHits: Fact[] = [];
  if (match && (cue || timeRefs.length)) {
    const sourceMessages = new Set<number>();
    for (const f of db.searchFacts(match, undefined, 15)) {
      if (f.message_id != null && exclude.has(f.message_id)) continue;
      // Same bar as message recall: one common word ("pricing") doesn't pull in unrelated facts.
      if (quality(keywords, distinctive, `${f.entity} ${f.attribute} ${f.value}`) < (keywords.length >= 2 ? 1.5 : 1)) continue;
      factHits.push(f);
      if (f.message_id != null && sourceMessages.size < 3 && !sourceMessages.has(f.message_id)) {
        sourceMessages.add(f.message_id);
        pick(f.message_id, "topic", 0);
      }
    }
  }

  // Expand hits into full exchanges (question + answer), deduplicated by the question.
  const exchanges = new Map<string, { messages: Message[]; reason: RecallReason; score: number }>();
  for (const { anchor, reason, score } of picked.values()) {
    const msgs = db.getExchange(anchor).filter((m) => !exclude.has(m.id));
    if (!msgs.length) continue;
    const key = String(msgs[0]!.id);
    const prev = exchanges.get(key);
    if (!prev || PRIORITY[reason] < PRIORITY[prev.reason]) exchanges.set(key, { messages: msgs, reason, score: Math.max(score, prev?.score ?? 0) });
  }

  const titles = new Map<string, string | null>();
  const titleOf = (cid: string) => {
    if (!titles.has(cid)) titles.set(cid, db.getConversation(cid)?.title ?? null);
    return titles.get(cid)!;
  };

  const ordered: RecalledExchange[] = [...exchanges.values()]
    .sort((a, b) => PRIORITY[a.reason] - PRIORITY[b.reason] || a.messages[0]!.created_at - b.messages[0]!.created_at)
    .map((e) => ({ messages: e.messages, reason: e.reason, conversationTitle: titleOf(e.messages[0]!.conversation_id) }));

  // (c) Facts: those recorded with the recalled answers, plus keyword matches when the user refers to the past.
  const factMap = new Map<number, Fact>();
  for (const f of db.factsForMessages(ordered.flatMap((e) => e.messages.map((m) => m.id)))) factMap.set(f.id, f);
  for (const f of factHits) factMap.set(f.id, f);
  const facts = [...factMap.values()].sort((a, b) => a.observed_at - b.observed_at || a.id - b.id);

  const budget = input.charBudget ?? config.memoryCharBudget;
  const { text: memory, included } = render(ordered, facts, notes, timezone, budget);

  return {
    memory,
    exchanges: included,
    facts,
    notes,
    stats: { keywords, cue, usedEmbeddings: qvec != null, ms: Math.round(performance.now() - t0) },
  };
}

/** Short description of what a day's conversations were about, for "nothing about this topic" notes. */
function describeTopics(db: Db, msgs: Message[]): string {
  const convs = [...new Set(msgs.map((m) => m.conversation_id))];
  const topics = convs.slice(0, 3).map((cid) => {
    const title = db.getConversation(cid)?.title;
    if (title) return `"${title}"`;
    const q = msgs.find((m) => m.conversation_id === cid && m.role === "user")?.text ?? "";
    return `"${clip(q, 60)}"`;
  });
  return `${convs.length} conversation${convs.length === 1 ? "" : "s"} (${topics.join(", ")}${convs.length > 3 ? ", …" : ""})`;
}

// ── Rendering ───────────────────────────────────────────────────────

function clip(s: string, max: number): string {
  const t = s.trim();
  return t.length <= max ? t : `${t.slice(0, max).replace(/\s+\S*$/, "")} …[truncated]`;
}

const REASON_LABEL: Record<RecallReason, string> = {
  "date+topic": "matches the date and topic",
  date: "from the date mentioned",
  topic: "matches the topic",
};

function renderExchange(e: RecalledExchange, tz: string, answerMax: number): string {
  const first = e.messages[0]!;
  const head = `### ${formatDateTime(first.created_at, tz)}${e.conversationTitle ? ` · "${e.conversationTitle}"` : ""} (${REASON_LABEL[e.reason]})`;
  const lines = [head];
  for (const m of e.messages) {
    lines.push(`${m.role === "user" ? "User" : "Assistant"}: ${clip(m.text, m.role === "user" ? 1_200 : answerMax)}`);
    if (m.role === "assistant" && m.sources.length) {
      lines.push(`Sources cited then: ${m.sources.map((s) => `[${s.n}] ${s.url}`).join(" ")}`);
    }
  }
  return lines.join("\n");
}

function renderFact(f: Fact, tz: string): string {
  return `- ${f.entity} · ${f.attribute}: ${f.value} (recorded ${formatDay(f.observed_at, tz)}${f.source_url ? `, ${f.source_url}` : ""})`;
}

function render(
  exchanges: RecalledExchange[],
  facts: Fact[],
  notes: string[],
  tz: string,
  budget: number,
): { text: string; included: RecalledExchange[] } {
  const parts: string[] = [];
  let used = 0;
  const add = (s: string) => {
    parts.push(s);
    used += s.length + 2;
  };

  if (notes.length) add(`## Date checks\n${notes.map((n) => `- ${n}`).join("\n")}`);

  const factLines = facts.slice(0, 40).map((f) => renderFact(f, tz));
  const factBlock = factLines.length ? `## Facts recorded in past answers (true as of the date shown)\n${factLines.join("\n")}` : "";
  const reserve = Math.min(factBlock.length + 2, Math.floor(budget * 0.3));

  const included: RecalledExchange[] = [];
  if (exchanges.length) add(`## Past exchanges (times in ${tz})`);
  for (const e of exchanges) {
    const room = budget - used - reserve;
    let block = renderExchange(e, tz, 3_000);
    if (block.length > room) block = renderExchange(e, tz, Math.max(400, room - 600));
    if (block.length > room) {
      if (included.length) break;
      block = block.slice(0, Math.max(room, 600));
    }
    add(block);
    included.push(e);
  }
  if (included.length < exchanges.length) add(`(${exchanges.length - included.length} more matching exchanges omitted for length.)`);

  if (factBlock) add(factBlock.length + used > budget ? factBlock.slice(0, Math.max(0, budget - used)) : factBlock);

  return { text: parts.join("\n\n"), included };
}
