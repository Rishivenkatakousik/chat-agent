// Ask the agent one question from the terminal: `npx tsx scripts/ask.ts "What's new in Postgres 18?"`
// Streams the answer to stdout; status lines and stats go to stderr. No memory, no persistence.
import { config, missingKeys } from "../src/config.js";
import { friendlyError, runTurn } from "../src/agent/turn.js";
import { resolveTimeRefs } from "../src/agent/time.js";

const message = process.argv.slice(2).join(" ") || "What's new in Postgres 18?";
const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
const now = Date.now();

const missing = missingKeys();
if (missing.length) {
  console.error(`Missing ${missing.join(", ")} in .env`);
  process.exit(1);
}

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
console.error(dim(`model ${config.chatModel} (${config.reasoningEffort}) · ${timezone}\n> ${message}\n`));

const controller = new AbortController();
process.on("SIGINT", () => controller.abort());

try {
  const { stats } = await runTurn({
    message,
    history: [],
    context: { now, timezone, timeRefs: resolveTimeRefs(message, now, timezone) },
    signal: controller.signal,
    onEvent: (e) => {
      if (e.type === "status") console.error(dim(`… ${e.text}`));
      else if (e.type === "text") process.stdout.write(e.delta);
      else if (e.type === "sources") {
        console.log("\n");
        for (const s of e.sources) console.log(dim(`[${s.n}] ${s.title} — ${s.url}${s.published ? ` (${s.published})` : ""}`));
      }
    },
  });
  console.error(
    dim(
      `\nfirst token ${stats.firstTokenMs ?? "-"}ms · total ${stats.totalMs}ms · ${stats.searches} searches · ${stats.rounds} rounds · ` +
        `tokens in ${stats.inputTokens} (cached ${stats.cachedTokens}) out ${stats.outputTokens}`,
    ),
  );
} catch (err) {
  console.error(`\nError: ${friendlyError(err)}`);
  process.exit(1);
}
