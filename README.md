# Minimi

A chat agent with one tool, web search, plus a memory of past conversations that understands dates
("last Tuesday I asked about Postgres hosting — has pricing changed?").

## Run it

Needs **Node 22.13 or later** (it uses Node's built-in SQLite).

```bash
cp .env.example .env      # add OPENAI_API_KEY and TAVILY_API_KEY
npm install
npm run seed              # demo history, so the memory questions have something to recall
npm run dev               # http://localhost:3000
```

The design is explained in **[DESIGN.md](DESIGN.md)**.

### Trying the memory questions

Questions like "Last Tuesday I asked about Postgres hosting, has pricing changed?" need a past
conversation to find. A fresh database has none, so either:

- `npm run seed` adds three back-dated demo conversations (Postgres hosting prices on Tuesday of
  last week, a 5-tool CRM shortlist on the most recent Monday, an unrelated chat yesterday), or
- `npm run import -- history.jsonl` loads your own dated history, one JSON object per line:
  `{"at":"2026-11-03T10:00:00+05:30","role":"user","text":"…","conversation":"postgres"}`.
  Set `MINIMI_NOW` in `.env` to ask questions as if it were a particular day.

### Other scripts

| Script | What it does |
|---|---|
| `npm test` | Unit tests with a fake model and fake search (no network, no keys). |
| `npm run eval` | Answer-quality checks against the live model and search (uses your keys). |
| `npm run bench -- <label> --runs=5` | Latency over the full chat path; medians over several runs. |
| `npm run typecheck`, `npm run format` | TypeScript check, Prettier. |

## How the code is organized

New to the project? Read **[CODEBASE_GUIDE.md](CODEBASE_GUIDE.md)** first. It explains the whole
flow from scratch, with diagrams.

Each folder is one part of the app. Imports only point downward in this list, so you can read
the code bottom-up (basics first) or top-down (follow a request).

| Folder | What it does |
|---|---|
| `src/main.ts` | Entry point: opens the database, starts the server, handles shutdown. |
| `src/server/` | HTTP layer (Hono). `app.ts` mounts the routes and the web client; `routes/` holds the endpoints. |
| `src/chat/` | One chat request end to end (`chat-service.ts`), plus per-conversation locks and background-job tracking. |
| `src/agent/` | One model turn: the system prompt and per-turn `<context>` (`prompt.ts`), conversation history, and the streaming tool loop (`agent-loop.ts`). |
| `src/memory/` | Reading memory before the model runs (`recall.ts`, with `query-analysis.ts`, `ranking.ts` and `render-memory.ts`) and writing it afterwards (`enrich.ts`: facts, titles, embeddings). |
| `src/search/` | The one tool: `web-search.ts` (Tavily) and `sources.ts` (citation numbers). |
| `src/time/` | "last Tuesday" → exact dates in the user's timezone, plus date formatting. |
| `src/llm/` | The shared OpenAI client, error messages, and embeddings. |
| `src/storage/` | SQLite: `database.ts` opens it, and there is one store per table (`conversations.ts`, `messages.ts`, `facts.ts`). |
| `src/types.ts`, `src/config.ts` | Shared data shapes and environment settings. |
| `public/` | The web client: plain HTML/CSS and ES modules in `public/js/` (no build step). |
| `scripts/` | Demo seed data, history import, a terminal chat client, a latency benchmark and an answer-quality eval. |
| `test/` | `node:test` suites that use a fake model and fake search (no network needed). |

### One message, step by step

```
Browser ──POST /api/chat──▶ server/routes/chat.ts      (validates, streams events as SSE)
  └▶ chat/chat-service.ts   startChat → runChat
       1. time/resolve-time-refs.ts   "last Tuesday" → [Tue 10 Nov, Tue 3 Nov]
       2. memory/recall.ts            past exchanges + facts for those dates/topics → <memory>
       3. agent/agent-loop.ts         stream the model; run web_search calls in parallel; repeat
       4. storage/messages.ts         store the question and the answer
       5. memory/enrich.ts            (background) extract facts, title, embeddings
```
