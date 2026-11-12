/**
 * Renders recall results as the text of the <memory> block the model reads: date-check notes,
 * past exchanges (with dates and sources) and recorded facts, trimmed to a character budget.
 */
import { formatDateTime, formatDay } from "../time/format.js";
import type { Fact } from "../types.js";
import type { RecalledExchange, RecallReason } from "./recall.js";

const QUESTION_CHARS = 1_200;
const ANSWER_CHARS = 3_000;
/** When an exchange doesn't fit, its answer is shortened, but never below this. */
const MIN_ANSWER_CHARS = 400;
/** Room kept for the header and the question when shortening an answer to fit. */
const EXCHANGE_OVERHEAD_CHARS = 600;
const MAX_FACT_LINES = 40;
/** Facts may claim up to this share of the budget before exchanges are placed. */
const FACT_RESERVE_SHARE = 0.3;
/** Blocks are joined with a blank line. */
const SEPARATOR = "\n\n";

const REASON_LABEL: Record<RecallReason, string> = {
  "date+topic": "matches the date and topic",
  date: "from the date mentioned",
  topic: "matches the topic",
};

/** Trims to `max` characters at a word boundary and marks the cut. */
export function clip(text: string, max: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max).replace(/\s+\S*$/, "")} …[truncated]`;
}

function renderExchange(exchange: RecalledExchange, timeZone: string, answerChars: number): string {
  const first = exchange.messages[0]!;
  const title = exchange.conversationTitle ? ` · "${exchange.conversationTitle}"` : "";
  const lines = [
    `### ${formatDateTime(first.created_at, timeZone)}${title} (${REASON_LABEL[exchange.reason]})`,
  ];

  for (const message of exchange.messages) {
    if (message.role === "user") {
      lines.push(`User: ${clip(message.text, QUESTION_CHARS)}`);
      continue;
    }
    lines.push(`Assistant: ${clip(message.text, answerChars)}`);
    if (message.sources.length > 0) {
      const cited = message.sources.map((source) => `[${source.n}] ${source.url}`).join(" ");
      lines.push(`Sources cited then: ${cited}`);
    }
  }
  return lines.join("\n");
}

function renderFact(fact: Fact, timeZone: string): string {
  const source = fact.source_url ? `, ${fact.source_url}` : "";
  return `- ${fact.entity} · ${fact.attribute}: ${fact.value} (recorded ${formatDay(fact.observed_at, timeZone)}${source})`;
}

function renderFactBlock(facts: Fact[], timeZone: string): string {
  if (facts.length === 0) return "";
  const lines = facts.slice(0, MAX_FACT_LINES).map((fact) => renderFact(fact, timeZone));
  return `## Facts recorded in past answers (true as of the date shown)\n${lines.join("\n")}`;
}

/** Collects text blocks and counts the characters they will take once joined. */
class BlockWriter {
  private readonly blocks: string[] = [];
  usedChars = 0;

  add(block: string): void {
    this.blocks.push(block);
    this.usedChars += block.length + SEPARATOR.length;
  }

  toString(): string {
    return this.blocks.join(SEPARATOR);
  }
}

/** Fits one exchange into `room` characters: full, then with a shorter answer, then cut. Null if it doesn't fit. */
function fitExchange(
  exchange: RecalledExchange,
  timeZone: string,
  room: number,
  isFirst: boolean,
): string | null {
  let block = renderExchange(exchange, timeZone, ANSWER_CHARS);
  if (block.length > room) {
    block = renderExchange(exchange, timeZone, Math.max(MIN_ANSWER_CHARS, room - EXCHANGE_OVERHEAD_CHARS));
  }
  if (block.length <= room) return block;
  // The first exchange is always shown (cut if needed); later ones are dropped instead.
  return isFirst ? block.slice(0, Math.max(room, EXCHANGE_OVERHEAD_CHARS)) : null;
}

export interface MemoryParts {
  exchanges: RecalledExchange[];
  facts: Fact[];
  notes: string[];
  timeZone: string;
  budget: number;
}

/** Returns the memory text and which exchanges made it in. */
export function renderMemory(parts: MemoryParts): { text: string; included: RecalledExchange[] } {
  const { exchanges, facts, notes, timeZone, budget } = parts;
  const writer = new BlockWriter();

  if (notes.length > 0) {
    writer.add(`## Date checks\n${notes.map((note) => `- ${note}`).join("\n")}`);
  }

  const factBlock = renderFactBlock(facts, timeZone);
  const factReserve = Math.min(factBlock.length + SEPARATOR.length, Math.floor(budget * FACT_RESERVE_SHARE));

  const included: RecalledExchange[] = [];
  if (exchanges.length > 0) writer.add(`## Past exchanges (times in ${timeZone})`);
  for (const exchange of exchanges) {
    const room = budget - writer.usedChars - factReserve;
    const block = fitExchange(exchange, timeZone, room, included.length === 0);
    if (block === null) break;
    writer.add(block);
    included.push(exchange);
  }

  const omitted = exchanges.length - included.length;
  if (omitted > 0) writer.add(`(${omitted} more matching exchanges omitted for length.)`);

  if (factBlock) {
    const fits = factBlock.length + writer.usedChars <= budget;
    writer.add(fits ? factBlock : factBlock.slice(0, Math.max(0, budget - writer.usedChars)));
  }

  return { text: writer.toString(), included };
}
