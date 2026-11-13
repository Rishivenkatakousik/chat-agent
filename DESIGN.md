# Minimi: design

A chat agent with one tool, web search, plus a memory of past conversations that understands dates.
The sample questions all need the same three things: find a past conversation by date, recall what
was said, and check it against the web today. The design is built around that.

## How it works

One message goes through five steps (`src/chat/chat-service.ts`):

1. **Resolve dates** (`src/time/`). "Last Tuesday", "on 3 November" or "two weeks ago" become exact
   days in the user's timezone. Ambiguity is kept: said on a Wednesday, "last Tuesday" gives both
   yesterday and the Tuesday before, and the stored conversations decide.
2. **Recall memory** (`src/memory/recall.ts`). One SQLite file is searched three ways: messages on
   the resolved dates, the whole history by keywords (FTS5) and by meaning (embeddings) merged with
   reciprocal rank fusion, and facts extracted from earlier answers. The result is placed in front
   of the message as a `<memory>` block, with notes such as "No conversations found on Tue 3 Nov".
3. **Model loop** (`src/agent/agent-loop.ts`). The answer streams. Each `web_search` call (Tavily)
   starts the moment its arguments are complete, and calls run in parallel. There are at most two
   search rounds, then the model must answer with numbered citations.
4. **Store** the question and the answer with its sources. Citation numbers continue across a
   conversation, so `[2]` in a follow-up still means the same page.
5. **Enrich in the background.** A small model extracts checkable facts (entity, attribute, value,
   source, date) and a title, and both messages are embedded. The reply never waits for this.

## Why this way

- **Memory is retrieved by code, before the model runs.** The brief allows one tool. Retrieval in
  code costs no model round trip (a pass costs about 4 s), behaves the same every time and is
  unit-tested. The price: the model cannot ask memory a second question, so a miss is final.
- **Dates are resolved by code.** Models guess weekdays badly. The model is shown exact dates, so
  it can say "On Tue 3 Nov you asked…" and search for news since that day.
- **The context is honest about gaps.** Empty dates, unrelated chats on a date and truncated lists
  are stated in `<memory>`, and the prompt forbids inventing past conversations.
- **Speed comes from fewer model passes.** Searches run in parallel inside one pass. A first round
  of two or more searches goes straight to the answer, unless one of them failed. The system
  prompt is static so it caches. In single runs on four questions, time to first token fell from
  12.3 s to 7.6 s and a full answer from 18.5 s to 12.8 s; `npm run bench` now reports medians.
- **One SQLite file** (Node's built-in driver) holds messages, the keyword index, vectors and
  facts. Date filter, keyword rank and similarity live in one place, and there is nothing to install.

## Considered and rejected

- **A `search_memory` tool.** It breaks "one tool" and adds a model round trip to every memory question.
- **A vector database.** One user's history is thousands of messages at most; a full scan takes
  milliseconds, and a second store would complicate the date filter and the setup.
- **Exa for search.** Tavily's date, topic and domain filters map directly onto "what changed since X".
- **A front-end framework.** The client is plain ES modules with no build step; the work is in the agent.
- **A larger search budget or full-page reads.** Both improve coverage and both cost latency; I did
  not adopt them without measurements.

## Known limits

- Recall rules (time phrases, cue words) are hand-written and English-only; unusual phrasing can miss.
- Search reads passages of up to 2,400 characters, not whole pages.
- Six searches per turn: a five-item "what changed" question gets one shared news search.
- Facts help recall; the old-versus-new comparison is still written by the model, not computed.
- Single user, single process, bound to localhost. There is no login.

## With another week

1. **Replace the recall rules with one small model call**, run in parallel with the embedding: it
   returns date ranges, topic terms and entities as JSON. Keep the rules as the fallback, and widen
   the search once when recall comes back empty.
2. **Let stored facts drive the re-check.** Memory already knows the entities and their source
   URLs, so code can start those searches alongside the model's first pass and build the
   then-versus-now table itself. That removes a model pass from the main question type.
3. **Grow the eval set** (`npm run eval`) and use it with the benchmark to decide the search budget
   and page-reading questions above.
4. **Multi-user support**: a user id on every row, and a login.
