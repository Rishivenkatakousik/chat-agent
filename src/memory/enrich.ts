/**
 * Background enrichment after each reply (writing memory), off the response path:
 *   - the cheap model extracts durable, checkable facts (prices, plans, versions, limits, dates,
 *     shortlists) and, for a new conversation, a short title;
 *   - the question and answer are embedded for semantic recall.
 * Failures are logged and never reach the user.
 */
import { z } from "zod";
import { config } from "../config.js";
import { embedMany as defaultEmbedMany, type EmbedMany } from "../llm/embeddings.js";
import { getOpenAI, type ResponsesClient } from "../llm/openai-client.js";
import type { Database } from "../storage/database.js";
import type { Conversation, FactInput, Message } from "../types.js";

const MAX_FACTS = 20;
const MAX_QUESTION_CHARS = 4_000;
const MAX_ANSWER_CHARS = 12_000;
const MAX_TITLE_CHARS = 80;
const EXTRACTION_TIMEOUT_MS = 30_000;
const BACKFILL_BATCH_SIZE = 50;
const BACKFILL_MAX_BATCHES = 20;

// ── Extraction schema and prompt ────────────────────────────────────

export const extraction = z.strictObject({
  title: z.string().nullable().describe("3-6 word title for the conversation, or null if not requested."),
  facts: z
    .array(
      z.strictObject({
        entity: z.string().describe("Product, company, person or list name, e.g. 'Neon', 'CRM shortlist'."),
        attribute: z
          .string()
          .describe("What is measured, e.g. 'Launch plan price', 'latest version', 'tools'."),
        value: z.string().describe("The value as stated, with units and qualifiers, e.g. '$19/mo (annual)'."),
        source_url: z
          .string()
          .nullable()
          .describe("URL of the cited source for this fact, from the given list, or null."),
      }),
    )
    .describe("Durable, checkable facts stated in the answer. Empty if none."),
});

export type Extraction = z.infer<typeof extraction>;

const { $schema: _ignored, ...extractionSchema } = z.toJSONSchema(extraction, {
  target: "draft-7",
}) as Record<string, unknown>;

const INSTRUCTIONS = `You extract structured memory from one exchange between a user and a research assistant.

Facts: record only durable, checkable facts the ASSISTANT stated that someone might later ask "has this changed?" about:
prices and plans, versions and release dates, limits and quotas, availability, rankings, and any list the user and assistant settled on (record a shortlist as one fact: entity = "<topic> shortlist", attribute = "tools" or "options", value = comma-separated names).
- One fact per entity+attribute. Keep values short but complete (units, billing period, qualifiers).
- source_url: the URL of the source the answer cited for that fact ([n] refers to the numbered sources list), else null.
- Skip opinions, advice, greetings, the user's own situation, and anything uncertain or hypothetical.
- If there is nothing worth recording, return an empty list.

Title: if requested, a 3-6 word title naming the topic (no quotes, no trailing period). Otherwise null.`;

// ── Types ───────────────────────────────────────────────────────────

/** Test seams: a fake model client and a fake batch embedder. */
export interface EnrichDependencies {
  client?: ResponsesClient;
  embedMany?: EmbedMany;
}

export interface EnrichResult {
  title: string | null;
  facts: number;
  embedded: number;
}

// ── Helpers ─────────────────────────────────────────────────────────

/** Strips quotes and a trailing period; null when nothing is left. */
function cleanTitle(title: string | null | undefined): string | null {
  const cleaned = (title ?? "").replace(/^["'\s]+|["'.\s]+$/g, "").replace(/\s+/g, " ");
  return cleaned ? cleaned.slice(0, MAX_TITLE_CHARS) : null;
}

/** Facts are worth extracting only from answers with sources or concrete numbers. */
function isWorthExtracting(answer: Message): boolean {
  return answer.sources.length > 0 || /\d/.test(answer.text);
}

function buildExtractionInput(
  question: Message,
  answer: Message,
  wantTitle: boolean,
  wantFacts: boolean,
): string {
  const sources = answer.sources.map((source) => `[${source.n}] ${source.url}`).join("\n") || "(none)";
  return [
    `Title requested: ${wantTitle ? "yes" : "no"}`,
    `Facts requested: ${wantFacts ? "yes" : "no"}`,
    "",
    `<user>\n${question.text.slice(0, MAX_QUESTION_CHARS)}\n</user>`,
    "",
    `<assistant>\n${answer.text.slice(0, MAX_ANSWER_CHARS)}\n</assistant>`,
    "",
    `<sources>\n${sources}\n</sources>`,
  ].join("\n");
}

async function requestExtraction(
  client: ResponsesClient,
  question: Message,
  answer: Message,
  wantTitle: boolean,
  wantFacts: boolean,
): Promise<Extraction> {
  const response = await client.responses.create(
    {
      model: config.extractModel,
      instructions: INSTRUCTIONS,
      input: buildExtractionInput(question, answer, wantTitle, wantFacts),
      text: {
        format: { type: "json_schema", name: "memory_extraction", schema: extractionSchema, strict: true },
      },
      reasoning: { effort: "low" },
      store: false,
    },
    { timeout: EXTRACTION_TIMEOUT_MS, maxRetries: 1 },
  );
  return extraction.parse(JSON.parse(response.output_text));
}

/** Keeps only well-formed, de-duplicated facts; a source_url must be one the answer actually cited. */
export function sanitizeFacts(facts: Extraction["facts"], answer: Message): FactInput[] {
  const citedUrls = new Set(answer.sources.map((source) => source.url));
  const seen = new Set<string>();
  const clean: FactInput[] = [];

  for (const fact of facts) {
    const entity = fact.entity.trim().slice(0, 120);
    const attribute = fact.attribute.trim().slice(0, 120);
    const value = fact.value.trim().slice(0, 500);
    if (!entity || !attribute || !value) continue;

    const key = `${entity.toLowerCase()}|${attribute.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const sourceUrl = fact.source_url && citedUrls.has(fact.source_url) ? fact.source_url : null;
    clean.push({ entity, attribute, value, source_url: sourceUrl });
    if (clean.length >= MAX_FACTS) break;
  }
  return clean;
}

/** Stores vectors for the messages that got one. Returns how many were stored. */
function storeEmbeddings(db: Database, messages: Message[], vectors: (Float32Array | null)[]): number {
  let stored = 0;
  messages.forEach((message, i) => {
    const vector = vectors[i];
    if (!vector) return;
    try {
      db.messages.setEmbedding(message.id, vector);
      stored++;
    } catch {
      // The message was deleted meanwhile.
    }
  });
  return stored;
}

// ── The two background jobs ─────────────────────────────────────────

/** Extracts facts and a title and stores them. Never throws. */
async function extractAndStore(
  db: Database,
  conversation: Conversation,
  question: Message,
  answer: Message,
  client: ResponsesClient | undefined,
): Promise<{ title: string | null; facts: number }> {
  const nothing = { title: null, facts: 0 };
  const wantTitle = !conversation.title;
  const wantFacts = isWorthExtracting(answer);
  if (!client || (!wantTitle && !wantFacts)) return nothing;

  try {
    const extracted = await requestExtraction(client, question, answer, wantTitle, wantFacts);
    // The conversation may have been deleted while the model was running.
    if (!db.conversations.get(conversation.id)) return nothing;

    let title: string | null = null;
    const cleanedTitle = wantTitle ? cleanTitle(extracted.title) : null;
    if (cleanedTitle && !db.conversations.get(conversation.id)?.title) {
      db.conversations.setTitle(conversation.id, cleanedTitle);
      title = cleanedTitle;
    }

    const facts = db.facts.insert({
      conversationId: conversation.id,
      messageId: answer.id,
      observedAt: answer.created_at,
      facts: wantFacts ? sanitizeFacts(extracted.facts, answer) : [],
    });
    return { title, facts };
  } catch (error) {
    console.warn(`[extract] ${conversation.id}: ${error instanceof Error ? error.message : error}`);
    return nothing;
  }
}

/** Embeds the question and the answer. Never throws. */
async function embedExchange(
  db: Database,
  conversationId: string,
  question: Message,
  answer: Message,
  embedMany: EmbedMany,
): Promise<number> {
  try {
    const vectors = await embedMany([question.text, answer.text]);
    return storeEmbeddings(db, [question, answer], vectors);
  } catch (error) {
    console.warn(`[embed] ${conversationId}: ${error instanceof Error ? error.message : error}`);
    return 0;
  }
}

// ── Entry points ────────────────────────────────────────────────────

/** Runs extraction and embedding for one exchange, in parallel. Never throws. */
export async function enrichExchange(
  db: Database,
  question: Message,
  answer: Message,
  deps: EnrichDependencies = {},
): Promise<EnrichResult> {
  const startedAt = performance.now();
  const conversation = db.conversations.get(answer.conversation_id);
  if (!conversation) return { title: null, facts: 0, embedded: 0 };

  const client = deps.client ?? (config.openaiApiKey ? getOpenAI() : undefined);
  const [extracted, embedded] = await Promise.all([
    extractAndStore(db, conversation, question, answer, client),
    embedExchange(db, conversation.id, question, answer, deps.embedMany ?? defaultEmbedMany),
  ]);

  const result: EnrichResult = { title: extracted.title, facts: extracted.facts, embedded };
  const titleNote = result.title ? `title "${result.title}", ` : "";
  const ms = Math.round(performance.now() - startedAt);
  console.log(
    `[enrich] ${conversation.id}: ${titleNote}${result.facts} facts, ${result.embedded} embeddings (${ms}ms)`,
  );
  return result;
}

/** Embeds messages that never got a vector (stored before a key was set, or when a call failed). */
export async function backfillEmbeddings(
  db: Database,
  deps: Pick<EnrichDependencies, "embedMany"> = {},
): Promise<number> {
  if (!config.openaiApiKey && !deps.embedMany) return 0;
  const embedMany = deps.embedMany ?? defaultEmbedMany;

  let total = 0;
  for (let batch = 0; batch < BACKFILL_MAX_BATCHES; batch++) {
    const missing = db.messages.listMissingEmbedding(BACKFILL_BATCH_SIZE);
    if (missing.length === 0) break;

    const vectors = await embedMany(missing.map((message) => message.text));
    const stored = storeEmbeddings(db, missing, vectors);
    total += stored;
    if (stored < missing.length) break; // embedding unavailable; try again on the next start
  }

  if (total > 0) console.log(`[embed] backfilled ${total} messages`);
  return total;
}
