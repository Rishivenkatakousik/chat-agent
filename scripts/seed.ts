// `npm run seed`: inserts back-dated demo conversations (re-running replaces them).
// Dates are relative to today in your timezone (override with SEED_TZ=Area/City).
import { TZDate } from "@date-fns/tz";
import { format } from "date-fns";
import { config } from "../src/config.js";
import { getDb } from "../src/db.js";
import { embedMany } from "../src/agent/embed.js";
import { safeTimeZone } from "../src/agent/time.js";
import { seedDemo } from "./seed-data.js";

const timezone = safeTimeZone(process.env.SEED_TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone);
const db = getDb();
const { messages, days } = seedDemo(db, { now: Date.now(), timezone });

console.log(`Seeded ${messages.length} messages into ${config.dbPath} (${timezone}):`);
const dayOf = (title: string) => format(new TZDate(Date.parse(days[title]!), timezone), "EEE d MMM yyyy, HH:mm");
for (const title of Object.keys(days)) console.log(`  ${dayOf(title)}  ${title}`);

if (config.openaiApiKey) {
  const vectors = await embedMany(messages.map((m) => m.text));
  let n = 0;
  for (const [i, v] of vectors.entries()) if (v) (db.setEmbedding(messages[i]!.id, v), n++);
  console.log(n ? `Embedded ${n} messages.` : "Embedding failed; recall will use dates and keywords only.");
} else {
  console.log("No OPENAI_API_KEY: skipped embeddings (recall still works on dates and keywords; run seed again after adding the key).");
}

const pg = format(new TZDate(Date.parse(days["Managed Postgres hosting prices"]!), timezone), "d MMMM");
console.log(`
Try asking:
  • On Monday we shortlisted 5 CRM tools. Has anything changed since?
  • What did I ask you on ${pg}? Is that still correct?
  • Last Tuesday I asked about Postgres hosting. Has pricing changed?`);
db.close();
