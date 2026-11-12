// `npm run seed`: inserts back-dated demo conversations (re-running replaces them).
// Dates are relative to today in your timezone (override with SEED_TZ=Area/City).
import { config } from "../src/config.js";
import { embedMany } from "../src/llm/embeddings.js";
import { getDatabase } from "../src/storage/database.js";
import { formatDateTime, safeTimeZone } from "../src/time/format.js";
import { TZDate } from "@date-fns/tz";
import { format } from "date-fns";
import { seedDemo } from "./seed-data.js";

const timezone = safeTimeZone(process.env.SEED_TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone);
const db = getDatabase();
const { messages, days } = seedDemo(db, { now: Date.now(), timezone });

console.log(`Seeded ${messages.length} messages into ${config.dbPath} (${timezone}):`);
for (const [title, startIso] of Object.entries(days)) {
  console.log(`  ${formatDateTime(Date.parse(startIso), timezone)}  ${title}`);
}

if (config.openaiApiKey) {
  const vectors = await embedMany(messages.map((message) => message.text));
  let embedded = 0;
  vectors.forEach((vector, i) => {
    if (!vector) return;
    db.messages.setEmbedding(messages[i]!.id, vector);
    embedded++;
  });
  console.log(
    embedded > 0
      ? `Embedded ${embedded} messages.`
      : "Embedding failed; recall will use dates and keywords only.",
  );
} else {
  console.log(
    "No OPENAI_API_KEY: skipped embeddings (recall still works on dates and keywords; run seed again after adding the key).",
  );
}

const postgresDay = format(
  new TZDate(Date.parse(days["Managed Postgres hosting prices"]!), timezone),
  "d MMMM",
);
console.log(`
Try asking:
  • On Monday we shortlisted 5 CRM tools. Has anything changed since?
  • What did I ask you on ${postgresDay}? Is that still correct?
  • Last Tuesday I asked about Postgres hosting. Has pricing changed?`);

db.close();
