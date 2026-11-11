import type OpenAI from "openai";
import { z } from "zod";
import { config } from "../config.js";
import type { Db, FactInput, Message } from "../db.js";
import { embedMany } from "./embed.js";
import { openai } from "./turn.js";

/**
 * Background enrichment after each reply, off the response path:
 *   - the cheap model extracts durable, checkable facts (prices, plans, versions,
 *     limits, dates, shortlists) and, for a new conversation, a short title;
 *   - the question and answer are embedded for semantic recall.
 * Failures are logged and never reach the user.
 */

const MAX_FACTS = 20;

export const extraction = z.strictObject({
  title: z.string().nullable().describe("3-6 word title for the conversation, or null if not requested."),
  facts: z
    .array(
      z.strictObject({
        entity: z.string().describe("Product, company, person or list name, e.g. 'Neon', 'CRM shortlist'."),
        attribute: z.string().describe("What is measured, e.g. 'Launch plan price', 'latest version', 'tools'."),
        value: z.string().describe("The value as stated, with units and qualifiers, e.g. '$19/mo (annual)'."),
        source_url: z.string().nullable().describe("URL of the cited source for this fact, from the given list, or null."),
      }),
    )
    .describe("Durable, checkable facts stated in the answer. Empty if none."),
});

export type Extraction = z.infer<typeof extraction>;

const { $schema: _ignored, ...extractionSchema } = z.toJSONSchema(extraction, { target: "draft-7" }) as Record<string, unknown>;

const INSTRUCTIONS = `You extract structured memory from one exchange between a user and a research assistant.

Facts: record only durable, checkable facts the ASSISTANT stated that someone might later ask "has this changed?" about:
prices and plans, versions and release dates, limits and quotas, availability, rankings, and any list the user and assistant settled on (record a shortlist as one fact: entity = "<topic> shortlist", attribute = "tools" or "options", value = comma-separated names).
- One fact per entity+attribute. Keep values short but complete (units, billing period, qualifiers).
- source_url: the URL of the source the answer cited for that fact ([n] refers to the numbered sources list), else null.
- Skip opinions, advice, greetings, the user's own situation, and anything uncertain or hypothetical.
- If there is nothing worth recording, return an empty list.

Title: if requested, a 3-6 word title naming the topic (no quotes, no trailing period). Otherwise null.`;

export interface EnrichDeps {
  client?: Pick<OpenAI, "responses">;
  embedMany?: typeof embedMany;
}

export interface EnrichResult {
  title: string | null;
  facts: number;
  embedded: number;
}

function cleanTitle(t: string | null | undefined): string | null {
  const s = (t ?? "").replace(/^["'\s]+|["'.\s]+$/g, "").replace(/\s+/g, " ");
  return s ? s.slice(0, 80) : null;
}

/** Facts are worth extracting only from answers with sources or concrete numbers. */
function worthExtracting(answer: Message): boolean {
  return answer.sources.length > 0 || /\d/.test(answer.text);
}

async function extract(
  client: Pick<OpenAI, "responses">,
  question: Message,
  answer: Message,
  wantTitle: boolean,
  wantFacts: boolean,
): Promise<Extraction> {
  const sources = answer.sources.map((s) => `[${s.n}] ${s.url}`).join("\n") || "(none)";
  const input =
    `Title requested: ${wantTitle ? "yes" : "no"}\nFacts requested: ${wantFacts ? "yes" : "no"}\n\n` +
    `<user>\n${question.text.slice(0, 4_000)}\n</user>\n\n<assistant>\n${answer.text.slice(0, 12_000)}\n</assistant>\n\n<sources>\n${sources}\n</sources>`;

  const res = await client.responses.create(
    {
      model: config.extractModel,
      instructions: INSTRUCTIONS,
      input,
      text: { format: { type: "json_schema", name: "memory_extraction", schema: extractionSchema, strict: true } },
      reasoning: { effort: "low" },
      store: false,
    },
    { timeout: 30_000, maxRetries: 1 },
  );
  return extraction.parse(JSON.parse(res.output_text));
}

/** Keeps only well-formed facts; a source_url must be one the answer actually cited. */
export function sanitizeFacts(facts: Extraction["facts"], answer: Message): FactInput[] {
  const cited = new Set(answer.sources.map((s) => s.url));
  const seen = new Set<string>();
  const out: FactInput[] = [];
  for (const f of facts) {
    const entity = f.entity.trim().slice(0, 120);
    const attribute = f.attribute.trim().slice(0, 120);
    const value = f.value.trim().slice(0, 500);
    if (!entity || !attribute || !value) continue;
    const key = `${entity.toLowerCase()}|${attribute.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ entity, attribute, value, source_url: f.source_url && cited.has(f.source_url) ? f.source_url : null });
    if (out.length >= MAX_FACTS) break;
  }
  return out;
}

/** Runs extraction and embedding for one exchange. Never throws. */
export async function enrichExchange(
  db: Db,
  question: Message,
  answer: Message,
  deps: EnrichDeps = {},
): Promise<EnrichResult> {
  const t0 = performance.now();
  const result: EnrichResult = { title: null, facts: 0, embedded: 0 };
  const conv = db.getConversation(answer.conversation_id);
  if (!conv) return result;

  const wantTitle = !conv.title;
  const wantFacts = worthExtracting(answer);
  const client = deps.client ?? (config.openaiApiKey ? openai() : undefined);

  const extractJob = (async () => {
    if (!client || (!wantTitle && !wantFacts)) return;
    try {
      const out = await extract(client, question, answer, wantTitle, wantFacts);
      // The conversation may have been deleted while the model was running.
      if (!db.getConversation(conv.id)) return;
      const title = wantTitle ? cleanTitle(out.title) : null;
      if (title && !db.getConversation(conv.id)?.title) {
        db.setTitle(conv.id, title);
        result.title = title;
      }
      const facts = wantFacts ? sanitizeFacts(out.facts, answer) : [];
      result.facts = db.insertFacts({ conversationId: conv.id, messageId: answer.id, observedAt: answer.created_at, facts });
    } catch (err) {
      console.warn(`[extract] ${conv.id}: ${err instanceof Error ? err.message : err}`);
    }
  })();

  const embedJob = (async () => {
    const vectors = await (deps.embedMany ?? embedMany)([question.text, answer.text]);
    [question, answer].forEach((m, i) => {
      const v = vectors[i];
      if (!v) return;
      try {
        db.setEmbedding(m.id, v);
        result.embedded++;
      } catch {
        /* message deleted meanwhile */
      }
    });
  })().catch((err) => console.warn(`[embed] ${conv.id}: ${err instanceof Error ? err.message : err}`));

  await Promise.all([extractJob, embedJob]);
  console.log(
    `[enrich] ${conv.id}: ${result.title ? `title "${result.title}", ` : ""}${result.facts} facts, ${result.embedded} embeddings (${Math.round(performance.now() - t0)}ms)`,
  );
  return result;
}

/** Embeds messages that never got a vector (written before a key was set, or when a call failed). */
export async function backfillEmbeddings(db: Db, deps: Pick<EnrichDeps, "embedMany"> = {}): Promise<number> {
  if (!config.openaiApiKey && !deps.embedMany) return 0;
  let total = 0;
  for (let batch = 0; batch < 20; batch++) {
    const missing = db.messagesMissingEmbedding(50);
    if (!missing.length) break;
    const vectors = await (deps.embedMany ?? embedMany)(missing.map((m) => m.text));
    let n = 0;
    missing.forEach((m, i) => {
      if (vectors[i]) (db.setEmbedding(m.id, vectors[i]!), n++);
    });
    total += n;
    if (n < missing.length) break; // embedding unavailable; try again next start
  }
  if (total) console.log(`[embed] backfilled ${total} messages`);
  return total;
}
