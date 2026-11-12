/**
 * Citation numbering for one turn. Every search result gets a number [n]; the same URL keeps
 * its number across searches, so the model's citations and the UI's source chips match.
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

  /** Returns the citation number for this page, assigning the next one if it's new. */
  add(result: { title: string; url: string; published: string | null }): number {
    const key = normalizeUrl(result.url);
    const existing = this.byUrl.get(key);
    if (existing) return existing.n;

    const source: Source = { n: this.byUrl.size + 1, title: result.title, url: result.url };
    if (result.published) source.published = result.published;
    this.byUrl.set(key, source);
    return source.n;
  }

  list(): Source[] {
    return [...this.byUrl.values()];
  }

  /** Only the sources the answer actually cites, keeping their numbers. All of them if none are cited. */
  cited(answer: string): Source[] {
    const citedNumbers = new Set([...answer.matchAll(/\[(\d+)\]/g)].map((match) => Number(match[1])));
    const all = this.list();
    return citedNumbers.size > 0 ? all.filter((source) => citedNumbers.has(source.n)) : all;
  }
}
