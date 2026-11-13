/**
 * Citation numbering. Every search result gets a number [n]; the same URL keeps its number, and
 * numbers continue across the turns of a conversation, so an [n] in an earlier answer still
 * points at the same page when a follow-up cites it again.
 */
import type { Source } from "../types.js";

/** Same page, different tracking: drops the #hash, utm_* parameters and a trailing slash. */
export function normalizeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    for (const param of [...parsed.searchParams.keys()]) {
      if (param.startsWith("utm_")) parsed.searchParams.delete(param);
    }
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return url;
  }
}

export class SourceRegistry {
  private readonly byUrl = new Map<string, Source>();
  private nextNumber = 1;
  /** How many new pages this turn's searches found (earlier turns' sources not counted). */
  foundThisTurn = 0;

  /** `earlier`: sources cited in earlier answers of this conversation, which keep their numbers. */
  constructor(earlier: readonly Source[] = []) {
    for (const source of earlier) {
      this.byUrl.set(normalizeUrl(source.url), source);
      this.nextNumber = Math.max(this.nextNumber, source.n + 1);
    }
  }

  /** Returns the citation number for this page, assigning the next one if it's new. */
  add(result: { title: string; url: string; published: string | null }): number {
    const key = normalizeUrl(result.url);
    const existing = this.byUrl.get(key);
    if (existing) return existing.n;

    const source: Source = { n: this.nextNumber++, title: result.title, url: result.url };
    if (result.published) source.published = result.published;
    this.byUrl.set(key, source);
    this.foundThisTurn++;
    return source.n;
  }

  /** The sources the answer actually cites, by number. */
  cited(answer: string): Source[] {
    const citedNumbers = new Set([...answer.matchAll(/\[(\d+)\]/g)].map((match) => Number(match[1])));
    return [...this.byUrl.values()].filter((source) => citedNumbers.has(source.n)).sort((a, b) => a.n - b.n);
  }
}
