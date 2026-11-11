import { marked } from "/vendor/marked.js";
import DOMPurify from "/vendor/purify.js";

/* Minimi web client: conversation list, streaming answers over SSE, citations and sources. No build step. */

const $ = (id) => document.getElementById(id);
const els = {
  app: $("app"),
  sidebar: $("sidebar"),
  scrim: $("scrim"),
  menuBtn: $("menu-btn"),
  convList: $("conv-list"),
  newChat: $("new-chat"),
  title: $("conv-title"),
  banner: $("banner"),
  thread: $("thread"),
  empty: $("empty"),
  suggestions: $("suggestions"),
  messages: $("messages"),
  form: $("composer"),
  input: $("input"),
  send: $("send"),
  stop: $("stop"),
};

const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;

const state = {
  conversations: [],
  currentId: null,
  /** AbortController of the answer being streamed, if any. */
  streaming: null,
};

// ── Markdown ───────────────────────────────────────────────────────

marked.setOptions({ gfm: true, breaks: false });
DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A" && node.getAttribute("href")) {
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener noreferrer");
  }
});

function renderMarkdown(el, text, sources) {
  el.innerHTML = DOMPurify.sanitize(marked.parse(text));
  if (sources?.length) linkCitations(el, sources);
}

/** Turns [n] in text (outside code and links) into small links to source n. */
function linkCitations(root, sources) {
  const byN = new Map(sources.map((s) => [s.n, s]));
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) =>
      /\[\d+\]/.test(n.nodeValue) && !n.parentElement.closest("code, pre, a") ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT,
  });
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const node of nodes) {
    const frag = document.createDocumentFragment();
    let last = 0;
    for (const m of node.nodeValue.matchAll(/\[(\d+)\]/g)) {
      const src = byN.get(Number(m[1]));
      if (!src) continue;
      frag.append(node.nodeValue.slice(last, m.index));
      const a = document.createElement("a");
      a.className = "cite";
      a.href = src.url;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.title = src.title;
      a.textContent = m[1];
      frag.append(a);
      last = m.index + m[0].length;
    }
    if (last === 0) continue;
    frag.append(node.nodeValue.slice(last));
    node.replaceWith(frag);
  }
}

// ── Formatting ─────────────────────────────────────────────────────

function domain(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function formatTime(ms) {
  const d = new Date(ms);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    ...(sameYear ? {} : { year: "numeric" }),
    hour: "2-digit",
    minute: "2-digit",
  });
}

function dayGroup(ms) {
  const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((startOfDay(new Date()) - startOfDay(new Date(ms))) / 86_400_000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return "Previous 7 days";
  if (days < 30) return "Previous 30 days";
  return "Older";
}

function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  el.append(...children.flat().filter((c) => c != null && c !== false));
  return el;
}

// ── API ────────────────────────────────────────────────────────────

async function api(path, opts) {
  const res = await fetch(path, opts);
  if (!res.ok && res.status !== 204) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Request failed (${res.status})`);
  }
  return res.status === 204 ? null : res.json();
}

// ── Sidebar ────────────────────────────────────────────────────────

async function loadConversations() {
  try {
    const { conversations } = await api("/api/conversations");
    state.conversations = conversations;
  } catch (err) {
    console.error(err);
  }
  renderSidebar();
  renderSuggestions();
}

function renderSidebar() {
  els.convList.replaceChildren();
  if (!state.conversations.length) {
    els.convList.append(h("div", { class: "conv-empty" }, "No conversations yet."));
    return;
  }
  let group = null;
  for (const c of state.conversations) {
    const g = dayGroup(c.updated_at);
    if (g !== group) {
      group = g;
      els.convList.append(h("div", { class: "conv-group" }, g));
    }
    const del = h("button", { class: "del", type: "button", "aria-label": "Delete conversation" }, "Delete");
    let armed = null;
    del.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (!armed) {
        // Two-step delete instead of a blocking confirm() dialog.
        del.textContent = "Confirm";
        del.classList.add("confirm");
        armed = setTimeout(() => {
          armed = null;
          del.textContent = "Delete";
          del.classList.remove("confirm");
        }, 3000);
        return;
      }
      clearTimeout(armed);
      await deleteConversation(c.id);
    });
    els.convList.append(
      h(
        "div",
        { class: `conv${c.id === state.currentId ? " active" : ""}`, "data-id": c.id },
        h("a", { href: `#c=${c.id}`, class: c.title ? "" : "untitled", title: label(c) }, label(c)),
        del,
      ),
    );
  }
}

/** Sidebar label: the title, else the first question, else a placeholder. */
function label(c) {
  return c.title || c.preview || "New chat";
}

function setTitle(title) {
  els.title.textContent = title || "New chat";
  document.title = title ? `${title} · Minimi` : "Minimi";
}

async function deleteConversation(id) {
  try {
    await api(`/api/conversations/${id}`, { method: "DELETE" });
  } catch (err) {
    showBanner(err.message);
    return;
  }
  state.conversations = state.conversations.filter((c) => c.id !== id);
  if (state.currentId === id) newChat();
  else renderSidebar();
}

// ── Suggestions (the challenge-style questions; dates follow the demo data if it is seeded) ──

function renderSuggestions() {
  const seededPg = state.conversations.find((c) => c.id === "seed-postgres-hosting");
  const pgDay = seededPg
    ? new Date(seededPg.created_at).toLocaleDateString(undefined, { day: "numeric", month: "long" })
    : "3 November";
  const items = [
    ["On Monday we shortlisted 5 CRM tools. Has anything changed since?", "Recall by weekday + fresh search"],
    [`What did I ask you on ${pgDay}? Is it still correct?`, "Recall by date + re-verify"],
    ["Last Tuesday I asked about Postgres hosting. Has pricing changed?", "Ambiguous date + then vs now"],
    ["What's new in the latest Node.js release?", "Plain web search"],
  ];
  els.suggestions.replaceChildren(
    ...items.map(([q, why]) =>
      h("button", { class: "suggestion", type: "button", onclick: () => send(q) }, q, h("small", {}, why)),
    ),
  );
}

// ── Thread ─────────────────────────────────────────────────────────

function nearBottom() {
  const t = els.thread;
  return t.scrollHeight - t.scrollTop - t.clientHeight < 120;
}

function scrollToBottom(force = false) {
  if (force || nearBottom()) els.thread.scrollTop = els.thread.scrollHeight;
}

function showThread(hasMessages) {
  els.empty.hidden = hasMessages;
}

function userMessageEl(text, createdAt) {
  return h(
    "div",
    { class: "msg user" },
    h("div", { class: "msg-meta" }, formatTime(createdAt)),
    h("div", { class: "bubble" }, text),
  );
}

function sourcesEl(sources) {
  if (!sources?.length) return null;
  return h(
    "div",
    { class: "sources" },
    sources.map((s) =>
      h(
        "a",
        { class: "source", href: s.url, target: "_blank", rel: "noopener noreferrer", title: s.title },
        h("span", { class: "n" }, String(s.n)),
        h("span", { class: "t" }, s.title || domain(s.url)),
        h("span", { class: "d" }, domain(s.url)),
      ),
    ),
  );
}

function assistantMessageEl(text, sources) {
  const answer = h("div", { class: "answer" });
  renderMarkdown(answer, text, sources);
  return h("div", { class: "msg assistant" }, answer, sourcesEl(sources));
}

async function openConversation(id) {
  if (state.streaming) state.streaming.abort();
  closeNav();
  state.currentId = id;
  renderSidebar();
  els.messages.replaceChildren();
  try {
    const { conversation, messages } = await api(`/api/conversations/${id}/messages`);
    if (state.currentId !== id) return; // switched again meanwhile
    setTitle(conversation.title || messages.find((m) => m.role === "user")?.text.slice(0, 80));
    els.messages.replaceChildren(
      ...messages.map((m) => (m.role === "user" ? userMessageEl(m.text, m.created_at) : assistantMessageEl(m.text, m.sources))),
    );
    showThread(messages.length > 0);
    scrollToBottom(true);
  } catch (err) {
    showBanner(err.message);
    newChat();
  }
}

function newChat() {
  if (state.streaming) state.streaming.abort();
  closeNav();
  state.currentId = null;
  if (location.hash) history.replaceState(null, "", location.pathname);
  setTitle(null);
  els.messages.replaceChildren();
  showThread(false);
  renderSidebar();
  els.input.focus();
}

// ── Sending and streaming ──────────────────────────────────────────

/** Reads an SSE response body and calls onEvent for each JSON event. */
async function readEvents(res, onEvent) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const data = block
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trimStart())
        .join("\n");
      if (data) onEvent(JSON.parse(data));
    }
  }
}

function setStreaming(controller) {
  state.streaming = controller;
  els.send.hidden = Boolean(controller);
  els.stop.hidden = !controller;
  updateSendEnabled();
}

function updateSendEnabled() {
  els.send.disabled = !els.input.value.trim() || Boolean(state.streaming);
}

async function send(text) {
  text = text.trim();
  if (!text || state.streaming) return;
  hideBanner();
  els.input.value = "";
  autosize();

  showThread(true);
  els.messages.append(userMessageEl(text, Date.now()));

  const live = h("div", { class: "status" }, h("span", { class: "dot" }), h("span", {}, "Thinking…"));
  const log = h("ul", { class: "status-log" });
  const answer = h("div", { class: "answer streaming" });
  const msg = h("div", { class: "msg assistant" }, log, live, answer);
  els.messages.append(msg);
  scrollToBottom(true);

  const controller = new AbortController();
  setStreaming(controller);

  let full = "";
  let sources = [];
  let frame = 0;
  let finished = false;
  const paint = () => {
    frame = 0;
    const stick = nearBottom();
    renderMarkdown(answer, full);
    if (stick) scrollToBottom(true);
  };
  const setStatus = (t) => {
    const prev = live.lastChild.textContent;
    if (prev && prev !== "Thinking…" && !prev.startsWith("Reading")) log.append(h("li", {}, prev));
    live.lastChild.textContent = t;
    live.hidden = false;
  };

  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ conversationId: state.currentId, message: text, timezone }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `Request failed (${res.status})`);
    }

    await readEvents(res, (e) => {
      switch (e.type) {
        case "conversation":
          if (e.created) {
            state.currentId = e.id;
            history.replaceState(null, "", `#c=${e.id}`);
            state.conversations.unshift({ id: e.id, title: null, preview: text.slice(0, 80), updated_at: Date.now() });
            renderSidebar();
          }
          break;
        case "status":
          setStatus(e.text);
          scrollToBottom();
          break;
        case "text":
          live.hidden = true;
          full += e.delta;
          if (!frame) frame = requestAnimationFrame(paint);
          break;
        case "sources":
          sources = e.sources;
          break;
        case "done": {
          finished = true;
          cancelAnimationFrame(frame);
          live.remove();
          answer.classList.remove("streaming");
          renderMarkdown(answer, e.text, e.sources);
          const chips = sourcesEl(e.sources);
          if (chips) msg.append(chips);
          const secs = (e.stats.totalMs / 1000).toFixed(1);
          const searches = e.stats.searches ? ` · ${e.stats.searches} search${e.stats.searches === 1 ? "" : "es"}` : "";
          msg.append(h("div", { class: "stats" }, `${secs}s${searches}`));
          scrollToBottom();
          // Answer is in: let the user type the next message while the title arrives.
          setStreaming(null);
          break;
        }
        case "title": {
          const c = state.conversations.find((x) => x.id === e.conversationId);
          if (c) c.title = e.title;
          if (state.currentId === e.conversationId) setTitle(e.title);
          renderSidebar();
          break;
        }
        case "error":
          finished = true;
          live.remove();
          answer.classList.remove("streaming");
          msg.append(h("div", { class: "error" }, e.message));
          break;
      }
    });
    if (!finished) throw new Error("The connection closed before the answer finished.");
    loadConversations(); // refresh order and timestamps
  } catch (err) {
    live.remove();
    answer.classList.remove("streaming");
    if (err.name === "AbortError") {
      if (full) renderMarkdown(answer, full, sources);
      msg.append(h("div", { class: "stats" }, "Stopped. This answer was not saved."));
    } else {
      msg.append(h("div", { class: "error" }, err.message || "Something went wrong."));
    }
  } finally {
    if (state.streaming === controller) setStreaming(null);
  }
}

// ── Banner ─────────────────────────────────────────────────────────

function showBanner(text) {
  els.banner.textContent = text;
  els.banner.hidden = false;
}
function hideBanner() {
  els.banner.hidden = true;
}

async function checkHealth() {
  try {
    const health = await api("/api/health");
    if (!health.ok) showBanner(`The server is missing ${health.missingKeys.join(" and ")}. Add it to .env and restart the server.`);
  } catch {
    showBanner("Can't reach the server. Is `npm run dev` running?");
  }
}

// ── Composer ───────────────────────────────────────────────────────

function autosize() {
  els.input.style.height = "auto";
  els.input.style.height = `${Math.min(els.input.scrollHeight, 200)}px`;
  updateSendEnabled();
}

els.input.addEventListener("input", autosize);
els.input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    send(els.input.value);
  }
});
els.form.addEventListener("submit", (e) => {
  e.preventDefault();
  send(els.input.value);
});
els.stop.addEventListener("click", () => state.streaming?.abort());
els.newChat.addEventListener("click", newChat);

// ── Mobile navigation ──────────────────────────────────────────────

function openNav() {
  els.app.classList.add("nav-open");
  els.scrim.hidden = false;
}
function closeNav() {
  els.app.classList.remove("nav-open");
  els.scrim.hidden = true;
}
els.menuBtn.addEventListener("click", openNav);
els.scrim.addEventListener("click", closeNav);

// ── Routing: #c=<id> keeps the open conversation across reloads ────

function route() {
  const id = new URLSearchParams(location.hash.slice(1)).get("c");
  if (id && id !== state.currentId) openConversation(id);
  else if (!id && state.currentId && !state.streaming) newChat();
}
window.addEventListener("hashchange", route);

// ── Start ──────────────────────────────────────────────────────────

checkHealth();
await loadConversations();
route();
updateSendEnabled();
els.input.focus();
