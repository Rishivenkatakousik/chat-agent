# Minimi

A chat agent with one tool, web search, plus a memory of past conversations that understands dates
("last Tuesday I asked about Postgres hosting — has pricing changed?").

## Run it

```bash
cp .env.example .env      # add OPENAI_API_KEY and TAVILY_API_KEY
npm install
npm run seed              # optional: back-dated demo conversations
npm run dev               # http://localhost:3000
```

Other scripts: `npm test`, `npm run typecheck`, `npm run format`.

## How the code is organized

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
| `scripts/` | Demo seed data, a terminal chat client, and a latency benchmark. |
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
