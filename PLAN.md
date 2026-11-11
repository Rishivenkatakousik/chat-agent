# PRD: Minimi Chat Agent (web search + time-aware memory)

## Context
Minimi's hiring challenge (`minimi-hiring-challenge.md`): build the best chat agent with **one tool, web search**, in JS/TS on Node (`npm install` → `npm run dev`, keys in `.env.example`), plus a one-page `DESIGN.md`. They judge **architecture**: fast, correct, good to talk to.

The sample questions reveal the real test. Each one needs **memory across sessions + time reasoning + fresh search**:
- "On **Monday** we shortlisted 5 CRM tools… changed since?" → recall which 5, search for news *after* that date.
- "What did I ask you on **3 November**? Still correct?" → find that exchange by date, re-verify it.
- "**Last Tuesday** I asked about Postgres hosting. Pricing changed?" → resolve the date, recall the prices quoted then, compare with today.

Decisions made with the user: **OpenAI** models, **Tavily** search (Exa considered), **minimal web UI**.

## Goals / non-goals
**Goals:** streamed answers that start quickly; cited, verified answers; reliable recall by date and topic; honest "I have no record of that"; clear diffs of *then vs now*.
**Non-goals:** multi-user auth, deployment, mobile app, extra tools (calculator, code execution), vector DB infrastructure.

## Architecture (one turn)
```
Browser ──POST /api/chat {conversationId, message, timezone}──▶ Hono server
  1. Time resolver   chrono-node + date-fns/@date-fns/tz: "last Tuesday" → [Tue 10 Nov, Tue 3 Nov] in user's tz
  2. Recall          hybrid search in SQLite: date-window filter, then FTS5 (BM25) + embedding cosine,
                     fused with reciprocal rank fusion → past exchanges + stored facts
                     (query embedding call runs in parallel with time resolution)
  3. Prompt build    static system prompt (cache-friendly) + per-turn <context>: now, resolved dates, <memory>
  4. Agent loop      OpenAI Responses API, streaming, ONE function tool: web_search → Tavily
                     (parallel calls allowed; max ~6 searches/turn; loop until final text)
  5. Stream to UI    SSE events: status ("Searching: …"), text deltas, sources, done
  6. Persist         user msg + final answer + sources (with timestamps) → SQLite
  7. Background      cheap model extracts structured facts {entity, attribute, value, source, observed_at}
                     + conversation title (doesn't block the reply)
```

**Key design choices (they also go in DESIGN.md):**
1. **Memory is context engineering, not a second tool.** The rules allow one tool. Code retrieves memory *before* the model runs, so it costs no extra round trip, behaves the same every time, and can be tested. *Rejected:* a `search_memory` tool (adds latency, breaks the one-tool rule). *Trade-off:* if retrieval misses, the model can't ask again. FTS recall plus date windows make misses rare; a recall tool goes in the "next week" list.
2. **Dates are resolved in code, in the user's timezone.** Ambiguity is kept rather than guessed: on a Wednesday, "last Tuesday" yields both candidate days and the stored data decides. Resolved dates are shown to the model so it can say "On Tue 3 Nov you asked…".
3. **Structured facts as well as transcripts.** "Has pricing changed?" becomes a field-by-field comparison (`Neon / Launch plan price / $19/mo / observed 3 Nov`) instead of re-reading prose. Extraction runs asynchronously on the cheap model.
4. **Answers are honest about the past.** If a date window has no conversations, the context says so explicitly and the prompt forbids inventing past exchanges.
5. **Search tuned for "since X".** The `web_search` tool schema exposes `query`, `start_date`, `topic` (general|news) and `max_results`, which map to Tavily's date and topic filters. The prompt tells the model to prefer primary sources (official pricing pages and changelogs) and to cite them.
6. **Speed.** Stream every token; let the model skip search for stable facts; run parallel searches; keep the system prompt static so OpenAI's automatic prompt caching applies; keep fact extraction off the critical path.

## Tech stack
| Layer | Choice | Why |
|---|---|---|
| Runtime | Node ≥ 22, TypeScript via `tsx` (no build step) | `npm run dev` just works |
| Server | **Hono** + `@hono/node-server`, SSE via `hono/streaming` | tiny, typed, good streaming |
| LLM | **`openai` SDK, Responses API**, streaming + function calling | current OpenAI agent API |
| Models | Chat: strongest current GPT model; background: its mini/nano variant. Both set via env (`OPENAI_MODEL`, `OPENAI_EXTRACT_MODEL`); exact IDs confirmed against OpenAI's model list at build time | quality for chat, low cost for extraction |
| Search | **Tavily** (`@tavily/core`): `search_depth`, `topic`, date filters, extracted content | built for agents; date filters fit the "since Monday" questions. *Exa rejected:* similar quality, weaker news/date handling for this use case |
| Storage | **`node:sqlite`** (built in) + FTS5 + embeddings stored as BLOBs (cosine computed in JS) | no native build, so `npm install` can't fail; one file; no third API key. *Pinecone rejected:* recall here is mostly by date and exact entity names, where vectors are weak; one user's history is tiny; a hosted DB adds an extra key, a network hop every turn and grader setup friction. Pinecone or pgvector becomes worthwhile with many users or millions of messages |
| Embeddings | OpenAI `text-embedding-3-small` (same key) | semantic recall ("the CRM tools" ↔ "customer relationship software") |
| Dates | `chrono-node` (natural-language parsing) + `date-fns` v4 + `@date-fns/tz` (`TZDate`, `startOfDay`, `startOfWeek`, `subDays`) | small and tree-shakable; date-fns alone can't parse "last Tuesday", hence chrono |
| Validation | `zod` (tool args, structured extraction output) | safe parsing of model output |
| UI | One static HTML/JS/CSS page; `marked` + `DOMPurify` served from node_modules | no frontend build; conversation list, streaming, search status, sources |
| Tests | `node:test` via `tsx --test` | no extra framework |

`.env.example`: `OPENAI_API_KEY`, `TAVILY_API_KEY` (required); `OPENAI_MODEL`, `OPENAI_EXTRACT_MODEL`, `PORT`, `DB_PATH` (optional).

## Data model (SQLite)
- `conversations(id, title, timezone, created_at, updated_at)`
- `messages(id, conversation_id, role, text, sources_json, embedding BLOB, created_at)` + `messages_fts`
  (embedding written after the reply, off the critical path)
- `facts(id, conversation_id, message_id, entity, attribute, value, source_url, observed_at)` + `facts_fts`

## Repo layout
```
src/server.ts          routes: POST /api/chat (SSE), GET /api/conversations[/:id], static files
src/config.ts          env loading (process.loadEnvFile), defaults
src/db.ts              schema, queries, FTS search
src/agent/time.ts      resolveTimeRefs(), describeNow()
src/agent/recall.ts    windows + keywords → exchanges, facts, empty windows (budgeted)
src/agent/prompt.ts    static system prompt + per-turn context block
src/agent/search.ts    Tavily wrapper → compact results {title, url, published, snippet}
src/agent/turn.ts      the streaming agent loop + persistence
src/agent/extract.ts   background fact + title extraction (structured output)
public/                index.html, app.js, style.css
scripts/seed.ts        seeds dated past conversations (Postgres on 3 Nov, CRM shortlist on Mon 9 Nov)
test/                  time.test.ts, recall.test.ts
DESIGN.md, README.md, .env.example
```

## Execution plan
Each step ends with a "Done when" check. Each step builds on the one before and ends in something that runs.

### Step 0: Save this plan
- Write this document to `/Users/rishi/Desktop/Projects/minimi/PLAN.md`. That's the only action once the plan is approved; building starts when you say go.

### Step 1: Scaffold the project
- `git init`; `package.json` with `"type": "module"`, `engines.node >=22.13` and scripts: `dev` (`tsx watch src/server.ts`), `start`, `seed`, `test`, `typecheck`.
- Install: `openai`, `@tavily/core`, `hono`, `@hono/node-server`, `chrono-node`, `date-fns`, `@date-fns/tz`, `zod`, `marked`, `dompurify`; dev: `typescript`, `tsx`, `@types/node`.
- Add `tsconfig.json` (strict, NodeNext), `.gitignore` (`node_modules`, `.env`, `data/*.db*`), `.env.example`.
- `src/config.ts`: `process.loadEnvFile()` in try/catch, defaults, and a warning when a key is missing.
- Confirm the current OpenAI chat and mini model IDs from OpenAI's model docs and set them as defaults.
- **Done when:** `npm install && npm run typecheck` passes.

### Step 2: Storage layer (`src/db.ts`)
- Open the database with `node:sqlite` and turn on WAL mode. Create the `conversations`, `messages` (with an `embedding` BLOB) and `facts` tables. Add the FTS5 tables `messages_fts` and `facts_fts`, kept in sync by triggers.
- Queries: create and list conversations; `appendMessage`; `getMessages`; `messagesInRange(from, to)`; `searchMessages(fts, window)` (BM25); `setEmbedding` and `allEmbeddings(window)`; `insertFacts`; `factsForMessages`; `searchFacts`.
- **Done when:** a smoke script inserts messages and gets them back through FTS and through a date range.

### Step 3: Time resolver (`src/agent/time.ts`) + tests
- `resolveTimeRefs(text, now, tz)` returns `{phrase, windows[{start, end, label}]}`, computed with `TZDate` in the user's timezone.
  - Relative phrases: yesterday, earlier today, N days/weeks ago, past N days, last/this week, last/this month.
  - Weekdays: "Monday" means the most recent one. "Last Tuesday" returns *both* candidate days. "Next X" is ignored.
  - Absolute dates go through chrono: "3 November", "Nov 3rd", ISO dates. A date with no year that falls in the future rolls back a year.
  - A bare "today" is not treated as a memory cue.
- `describeNow(now, tz)` produces a string like "Wednesday 11 Nov 2026, 12:30 (Asia/Kolkata, UTC+05:30)".
- `test/time.test.ts`: the three challenge phrasings, plus edge cases at timezone and day boundaries and on the same weekday as today.
- **Done when:** `npm test` passes.

### Step 4: Web search tool (`src/agent/search.ts`)
- Function tool schema (zod → JSON schema): `query` (required), `topic` (`general|news`), `start_date` (YYYY-MM-DD), `max_results` (≤8).
- Call Tavily with `search_depth: "advanced"`, the date and topic filters, and content included. Results are compacted to `{title, url, published_date, content ≤ ~1,200 chars}`.
- Errors come back as a tool result `{error}` rather than being thrown, so the model can retry or tell the user.
- **Done when:** a script searches "Neon Postgres pricing" and prints compact results.

### Step 5: Agent loop (`src/agent/turn.ts`, `src/agent/prompt.ts`)
- **Static system prompt:** the persona (concise and direct), when to search and when not to, primary sources first, inline citations `[n]`, how to handle change questions (then → now → what changed), honesty rules for memory, and a rule against inventing past conversations.
- **Per-turn context block** placed before the user's text: current time, resolved date windows, and `<memory>` (filled in at step 7).
- Loop: run `responses.create({stream: true, tools: [web_search]})`; stream text deltas; collect function calls; run them in parallel; send the outputs back; repeat until there are no more calls. Searches are capped per turn, and when the cap is hit the model is told to answer with what it has.
- The turn emits events: `status`, `text`, `sources`, `done`, `error`.
- **Done when:** a CLI test script asks "What's new in Postgres 18?" and streams a cited answer.

### Step 6: Server and persistence (`src/server.ts`)
- Hono routes: `POST /api/chat` (SSE through `streamSSE`), `GET /api/conversations`, `GET /api/conversations/:id/messages`, `DELETE /api/conversations/:id`, and static files from `public/` plus `marked` and `dompurify` from node_modules.
- Store the user message before the run and the assistant message after it (text, sources, timestamp). On an error, store nothing partial.
- **Done when:** `curl -N` against `/api/chat` streams events and the rows appear in the database.

### Step 7: Recall (`src/agent/recall.ts`) + seed data
- Keywords: the user's text minus stopwords and time words, turned into an FTS OR-query.
- In parallel: embed the query (`text-embedding-3-small`) and resolve the time refs.
- Candidates:
  - (a) Messages inside the date windows. Keyword and vector hits rank first; if nothing matches, the whole window is included.
  - (b) Global hybrid hits, using reciprocal rank fusion of BM25 and cosine scores. These are included only when the score is high enough or the message contains a memory cue ("I asked", "we discussed", "since", "still").
  - (c) Facts linked to the hit messages, plus FTS matches on facts.
- Hits expand into full exchanges (user question + assistant answer). Results are deduplicated, sorted by priority then time, and trimmed to a character budget.
- Report empty windows: "No conversations found on Tue 3 Nov".
- Render the results into the `<memory>` block, with dates shown in the user's timezone.
- `scripts/seed.ts` inserts back-dated conversations: Postgres hosting prices on Tue 3 Nov, a 5-tool CRM shortlist on Mon 9 Nov, and one unrelated chat. It writes embeddings and facts as well.
- `test/recall.test.ts` checks that seeded data plus each challenge question returns the right exchange.
- **Done when:** all three challenge questions recall the right past exchange (checked by test and in the live chat).

### Step 8: Background enrichment (`src/agent/extract.ts`)
- After each reply, with no `await` on the response path:
  - The mini model with structured output (zod) returns `{title?, facts[{entity, attribute, value, source_url}]}`. Only durable, checkable facts are kept: prices, plans, versions, limits, dates, shortlists.
  - Embed the user and assistant messages and store the vectors.
  - Set the conversation title if it doesn't have one.
- **Done when:** after a pricing question, the `facts` rows exist and the title shows in the conversation list.

### Step 9: Web UI (`public/`)
- Sidebar with the conversation list and a "New chat" button; the main pane holds messages and an input box (Enter sends, Shift+Enter adds a newline).
- Reads the SSE stream with `fetch` and a ReadableStream. Shows a live status line ("Searching: neon pricing…"). Renders markdown incrementally through DOMPurify, with numbered source chips below each answer.
- Sends `Intl.DateTimeFormat().resolvedOptions().timeZone` with every message. Supports light and dark mode and works at phone width.
- **Done when:** the three challenge questions work end to end in the browser.

### Step 10: Quality pass
- Test on real chat: follow-ups, a question with no search needed, a date with no history, ambiguous "last Tuesday", conflicting sources, a stale-answer check, and a very long answer.
- Tune the prompt and the recall thresholds. Measure time-to-first-token and total latency, and trim search counts or content size where it helps.
- Handle errors: missing keys, Tavily failure, rate limits from the OpenAI API, and a client disconnect, which should abort the run.

### Step 11: Docs and submission
- `DESIGN.md` (one page): how it works, why, what was considered and rejected (Pinecone, a memory tool, the Anthropic or Exa search backends, a Next.js front end), and what I'd do with another week.
- `README.md`: setup (`cp .env.example .env`, `npm install`, `npm run seed`, `npm run dev`) and the demo questions.
- Final check: fresh clone → `npm install` → `npm run dev`. Then push to a public GitHub repo.

## Verification
- `npm test`: time resolution cases (Monday / last Tuesday / 3 November / yesterday / last week, across timezones) and recall ranking.
- `npm run seed && npm run dev`, then ask the three sample questions. Each should cite the correct past date, re-search, and report concrete differences with sources.
- Ask about a date with no history → the agent says it has no record.
- Run `npm typecheck`, then do a clean `rm -rf node_modules && npm install && npm run dev` to prove the grader's setup path.

## "Another week" list (for DESIGN.md)
Fall back to a recall tool when retrieval is empty; sqlite-vec/pgvector once history grows; scheduled re-checks of stored prices ("watchlist"); an eval set built from the challenge-style questions; multi-user support.
