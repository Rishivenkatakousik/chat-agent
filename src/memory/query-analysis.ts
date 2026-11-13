/**
 * Reading the user's message for recall: which content words to search for, whether the
 * message points at a past conversation ("I asked", "we discussed"), and how well a stored
 * text matches those words.
 */
import type { Database } from "../storage/database.js";
import { toFtsQuery } from "../storage/sql.js";
import type { TimeRef } from "../types.js";

const MAX_KEYWORDS = 12;
/** A keyword is distinctive when it occurs in at most this share of all messages ("weekend" yes, "pricing" no). */
const DISTINCTIVE_SHARE = 0.25;

/** Words that carry no topic: grammar, chat filler, memory verbs and time words. */
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

// ── Memory cues: phrases that refer to an earlier conversation ──────

const PAST_VERB =
  "(?:ask|asked|discuss|discussed|talk|talked|shortlist|shortlisted|compare|compared|chose|choose|pick|picked|decide|decided|say|said|mention|mentioned|look|looked|research|researched|plan|planned|went over|go over|speak|spoke|chat|chatted)";

const MEMORY_CUE = new RegExp(
  [
    // "I asked", "we have discussed", "I've already asked", "we had once talked"
    `\\b(?:i|we)(?:'ve|'d)?(?:\\s+(?:have|had|did|already|once|ever|previously|just|also|have already|had once)){0,2}\\s+${PAST_VERB}\\b`,
    // "did I ask", "have we discussed", "when did we talk"
    `\\b(?:did|have|had)\\s+(?:i|we)\\s+(?:ever\\s+|already\\s+)?${PAST_VERB}\\b`,
    // "you said", "you once suggested", "you have told me"
    `\\byou(?:'ve)?(?:\\s+(?:have|had|once|already|just))?\\s+(?:said|told|suggested|recommended|mentioned|found|quoted|listed|gave|planned|answered|replied)\\b`,
    // "last time", "the other day", "our conversation", "the list", ...
    `\\b(?:last time|previously|remember|recall|one day|the other day|some time ago|a while (?:ago|back)|our (?:chat|conversation|discussion|talk)|that (?:list|chat|conversation)|the list|shortlist|history)\\b`,
  ].join("|"),
  "i",
);

/**
 * Words that often, but not always, point at an earlier answer ("has it changed?", "is it still…").
 * "Is Python still popular?" has one too, so on their own they prove nothing: recall counts them
 * only when the message also names a date or a topic that exists in the history.
 */
const CHANGE_CUE = /\b(?:earlier|again|still|since|changed|any changes)\b/i;

/** The message clearly refers to an earlier conversation ("I asked", "we discussed", "last time"). */
export function hasMemoryCue(message: string): boolean {
  return MEMORY_CUE.test(message);
}

/** The message asks about change over time, which may or may not refer to an earlier conversation. */
export function hasChangeCue(message: string): boolean {
  return CHANGE_CUE.test(message);
}

// ── Keywords ────────────────────────────────────────────────────────

/** Words with letters, digits and a few inner symbols: "next.js", "c++", "c#", "don't". */
const WORD = /[\p{L}\p{N}][\p{L}\p{N}+#.\-']*[\p{L}\p{N}+#]|[\p{L}]/gu;
/** Dotted names that are one word: "next.js", "asp.net", "socket.io". */
const DOTTED_NAME = /\.(?:js|ts|net|io|ai|py|rb|go|sh)$/;
/** Bare numbers and ordinals are mostly dates or counts, not topics. */
const NUMBER_OR_ORDINAL = /^\d{1,4}(?:st|nd|rd|th)?$/;

/** "next.js" stays whole; "lisdon.can" (a missing space) becomes "lisdon" + "can". */
function splitJoinedWords(word: string): string[] {
  if (!word.includes(".") || DOTTED_NAME.test(word)) return [word];
  return word.split(".");
}

/** Content words of the message, minus stopwords, time words and the resolved time phrases. */
export function extractKeywords(message: string, timeRefs: TimeRef[] = []): string[] {
  let text = message.toLowerCase();
  for (const ref of timeRefs) text = text.replace(ref.phrase.toLowerCase(), " ");

  const words = (text.match(WORD) ?? []).flatMap(splitJoinedWords);
  const keywords: string[] = [];
  for (const rawWord of words) {
    const word = rawWord.replace(/'s$/, "");
    if (word.length < 2 || STOPWORDS.has(word) || NUMBER_OR_ORDINAL.test(word)) continue;
    if (!keywords.includes(word)) keywords.push(word);
  }
  return keywords.slice(0, MAX_KEYWORDS);
}

// ── Matching ────────────────────────────────────────────────────────

/** Crude stem for coverage checks (FTS itself uses the porter stemmer). */
function stem(word: string): string {
  return word.replace(/(?:ing|edly|ed|es|s|ly)$/, "").slice(0, 7);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Whether a keyword occurs in the text, matching at word starts (so "pick" doesn't match "topic"). */
function containsKeyword(text: string, keyword: string): boolean {
  const pattern = new RegExp(`(?:^|[^\\p{L}\\p{N}])${escapeRegExp(stem(keyword))}`, "u");
  return pattern.test(text.toLowerCase());
}

/**
 * How well a text matches the keywords: a distinctive keyword counts 1, a common one 0.5.
 * So "weekend" alone (one conversation) is a real signal, while "pricing" (everywhere) needs
 * a second word with it.
 */
export function keywordMatchQuality(
  keywords: string[],
  distinctive: ReadonlySet<string>,
  text: string,
): number {
  let quality = 0;
  for (const keyword of keywords) {
    if (containsKeyword(text, keyword)) quality += distinctive.has(keyword) ? 1 : 0.5;
  }
  return quality;
}

/** Keywords that are rare across the whole history, measured by how many messages contain them. */
export function findDistinctiveKeywords(db: Database, keywords: string[]): Set<string> {
  const totalMessages = db.messages.count();
  const maxMatches = Math.max(1, totalMessages * DISTINCTIVE_SHARE);

  return new Set(
    keywords.filter((keyword) => {
      const match = toFtsQuery([keyword]);
      const matches = match ? db.messages.countMatches(match) : 0;
      return matches > 0 && matches <= maxMatches;
    }),
  );
}
