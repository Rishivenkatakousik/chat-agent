// `npm run import -- history.jsonl`: loads your own dated history, so the memory questions can be
// tried on conversations other than the demo seed. One JSON object per line:
//
//   {"at":"2026-11-03T10:00:00+05:30","role":"user","text":"Compare Neon and Supabase pricing","conversation":"postgres"}
//   {"at":"2026-11-03T10:00:20+05:30","role":"assistant","text":"Neon Launch is $19/mo …","conversation":"postgres"}
//
// `conversation` groups lines into chats (default: one chat). Importing the same file again replaces
// what it imported before. Set MINIMI_NOW in .env to ask questions as if it were a certain day.
import { readFileSync } from "node:fs";
import { z } from "zod";
import { backfillEmbeddings } from "../src/memory/enrich.js";
import { getDatabase } from "../src/storage/database.js";
import { safeTimeZone } from "../src/time/format.js";

const IMPORT_PREFIX = "import-";

const lineSchema = z.object({
  at: z.string().refine((value) => !Number.isNaN(Date.parse(value)), "`at` is not a date"),
  role: z.enum(["user", "assistant"]),
  text: z.string().min(1),
  conversation: z.string().min(1).default("history"),
});

const path = process.argv[2];
if (!path) {
  console.error("Usage: npm run import -- <file.jsonl>");
  process.exit(1);
}

const rows = readFileSync(path, "utf8")
  .split("\n")
  .map((line, index) => ({ line: line.trim(), number: index + 1 }))
  .filter(({ line }) => line)
  .map(({ line, number }) => {
    try {
      const row = lineSchema.parse(JSON.parse(line));
      return { ...row, at: Date.parse(row.at), conversationId: `${IMPORT_PREFIX}${row.conversation}` };
    } catch (error) {
      const reason = error instanceof z.ZodError ? z.prettifyError(error) : String(error);
      console.error(`Line ${number} of ${path} is not valid:\n${reason}`);
      process.exit(1);
    }
  })
  .sort((a, b) => a.at - b.at);

const timezone = safeTimeZone(process.env.SEED_TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone);
const db = getDatabase();

db.transaction(() => {
  for (const id of new Set(rows.map((row) => row.conversationId))) db.conversations.delete(id);

  for (const row of rows) {
    if (!db.conversations.get(row.conversationId)) {
      db.conversations.create({ id: row.conversationId, timezone, createdAt: row.at });
    }
    db.messages.append({
      conversationId: row.conversationId,
      role: row.role,
      text: row.text,
      createdAt: row.at,
    });
  }
});

const embedded = await backfillEmbeddings(db);
console.log(
  `Imported ${rows.length} messages (${timezone}); embedded ${embedded}.` +
    (embedded === 0 ? " Without embeddings, recall uses dates and keywords only." : ""),
);
db.close();
