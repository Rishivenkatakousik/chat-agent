/**
 * The main pane: the message thread, opening and starting conversations, and sending a message
 * with its answer streamed in live (status lines, markdown, citations, source chips).
 */
import { postChat, readSseEvents, api } from "./api.js";
import { domain, formatTime, h } from "./dom.js";
import { renderMarkdown } from "./markdown.js";
import { closeNav, els, hideBanner, setPageTitle, showBanner, state, timezone } from "./page.js";
import { loadConversations, renderSidebar } from "./sidebar.js";

const THINKING = "Thinking…";
/** Within this many pixels of the bottom, new content keeps the thread scrolled down. */
const STICK_TO_BOTTOM_PX = 120;
const MAX_INPUT_HEIGHT_PX = 200;

// ── Scrolling ──────────────────────────────────────────────────────

function isNearBottom() {
  const thread = els.thread;
  return thread.scrollHeight - thread.scrollTop - thread.clientHeight < STICK_TO_BOTTOM_PX;
}

function scrollToBottom(force = false) {
  if (force || isNearBottom()) els.thread.scrollTop = els.thread.scrollHeight;
}

/** Hides the empty-state welcome once there are messages. */
function showThread(hasMessages) {
  els.empty.hidden = hasMessages;
}

// ── Message elements ───────────────────────────────────────────────

function userMessageElement(text, createdAt) {
  return h(
    "div",
    { class: "msg user" },
    h("div", { class: "msg-meta" }, formatTime(createdAt)),
    h("div", { class: "bubble" }, text),
  );
}

function sourceChips(sources) {
  if (!sources?.length) return null;
  return h(
    "div",
    { class: "sources" },
    sources.map((source) =>
      h(
        "a",
        {
          class: "source",
          href: source.url,
          target: "_blank",
          rel: "noopener noreferrer",
          title: source.title,
        },
        h("span", { class: "n" }, String(source.n)),
        h("span", { class: "t" }, source.title || domain(source.url)),
        h("span", { class: "d" }, domain(source.url)),
      ),
    ),
  );
}

function assistantMessageElement(text, sources) {
  const answer = h("div", { class: "answer" });
  renderMarkdown(answer, text, sources);
  return h("div", { class: "msg assistant" }, answer, sourceChips(sources));
}

function messageElement(message) {
  return message.role === "user"
    ? userMessageElement(message.text, message.created_at)
    : assistantMessageElement(message.text, message.sources);
}

// ── Suggestions (the challenge-style questions; dates follow the demo data if it is seeded) ──

export function renderSuggestions(onPick) {
  const seededPostgres = state.conversations.find((c) => c.id === "seed-postgres-hosting");
  const postgresDay = seededPostgres
    ? new Date(seededPostgres.created_at).toLocaleDateString(undefined, { day: "numeric", month: "long" })
    : "3 November";

  const items = [
    ["On Monday we shortlisted 5 CRM tools. Has anything changed since?", "Recall by weekday + fresh search"],
    [`What did I ask you on ${postgresDay}? Is it still correct?`, "Recall by date + re-verify"],
    ["Last Tuesday I asked about Postgres hosting. Has pricing changed?", "Ambiguous date + then vs now"],
    ["What's new in the latest Node.js release?", "Plain web search"],
  ];
  els.suggestions.replaceChildren(
    ...items.map(([question, why]) =>
      h(
        "button",
        { class: "suggestion", type: "button", onclick: () => onPick(question) },
        question,
        h("small", {}, why),
      ),
    ),
  );
}

// ── Opening and starting conversations ─────────────────────────────

export async function openConversation(id) {
  state.streaming?.abort();
  closeNav();
  state.currentId = id;
  renderSidebar();
  els.messages.replaceChildren();

  try {
    const { conversation, messages } = await api(`/api/conversations/${id}/messages`);
    if (state.currentId !== id) return; // switched again meanwhile

    const firstQuestion = messages.find((message) => message.role === "user");
    setPageTitle(conversation.title || firstQuestion?.text.slice(0, 80));
    els.messages.replaceChildren(...messages.map(messageElement));
    showThread(messages.length > 0);
    scrollToBottom(true);
  } catch (error) {
    showBanner(error.message);
    newChat();
  }
}

export function newChat() {
  state.streaming?.abort();
  closeNav();
  state.currentId = null;
  if (location.hash) history.replaceState(null, "", location.pathname);
  setPageTitle(null);
  els.messages.replaceChildren();
  showThread(false);
  renderSidebar();
  els.input.focus();
}

// ── Composer ───────────────────────────────────────────────────────

/** Grows the input with its content, up to a maximum height. */
export function autosize() {
  els.input.style.height = "auto";
  els.input.style.height = `${Math.min(els.input.scrollHeight, MAX_INPUT_HEIGHT_PX)}px`;
  updateSendEnabled();
}

export function updateSendEnabled() {
  els.send.disabled = !els.input.value.trim() || Boolean(state.streaming);
}

/** Swaps the send button for a stop button while an answer streams. */
function setStreaming(controller) {
  state.streaming = controller;
  els.send.hidden = Boolean(controller);
  els.stop.hidden = !controller;
  updateSendEnabled();
}

// ── The answer being streamed ──────────────────────────────────────

/** The assistant message that fills in while the answer streams. */
class PendingAnswer {
  constructor() {
    this.statusText = h("span", {}, THINKING);
    this.liveStatus = h("div", { class: "status" }, h("span", { class: "dot" }), this.statusText);
    this.statusLog = h("ul", { class: "status-log" });
    this.answer = h("div", { class: "answer streaming" });
    this.element = h("div", { class: "msg assistant" }, this.statusLog, this.liveStatus, this.answer);

    this.text = "";
    this.sources = [];
    this.frame = 0;
    /** True once the server sent `done` or `error`. */
    this.finished = false;
  }

  /** Shows a new status line; the previous one moves into the log (except "Thinking…" and "Reading…"). */
  setStatus(text) {
    const previous = this.statusText.textContent;
    if (previous && previous !== THINKING && !previous.startsWith("Reading")) {
      this.statusLog.append(h("li", {}, previous));
    }
    this.statusText.textContent = text;
    this.liveStatus.hidden = false;
  }

  /** Adds streamed text; repaints at most once per animation frame. */
  appendText(delta) {
    this.liveStatus.hidden = true;
    this.text += delta;
    if (!this.frame) this.frame = requestAnimationFrame(() => this.paint());
  }

  paint() {
    this.frame = 0;
    const stick = isNearBottom();
    renderMarkdown(this.answer, this.text);
    if (stick) scrollToBottom(true);
  }

  /** Final render with citations, source chips and timing. */
  complete({ text, sources, stats }) {
    this.finished = true;
    cancelAnimationFrame(this.frame);
    this.stopLiveParts();
    renderMarkdown(this.answer, text, sources);

    const chips = sourceChips(sources);
    if (chips) this.element.append(chips);

    const seconds = (stats.totalMs / 1000).toFixed(1);
    const searches = stats.searches ? ` · ${stats.searches} search${stats.searches === 1 ? "" : "es"}` : "";
    this.element.append(h("div", { class: "stats" }, `${seconds}s${searches}`));
  }

  /** The server reported an error. */
  showError(message) {
    this.finished = true;
    this.stopLiveParts();
    this.element.append(h("div", { class: "error" }, message));
  }

  /** The request failed or was stopped by the user. */
  fail(error) {
    this.stopLiveParts();
    if (error.name === "AbortError") {
      if (this.text) renderMarkdown(this.answer, this.text, this.sources);
      this.element.append(h("div", { class: "stats" }, "Stopped. This answer was not saved."));
    } else {
      this.element.append(h("div", { class: "error" }, error.message || "Something went wrong."));
    }
  }

  stopLiveParts() {
    this.liveStatus.remove();
    this.answer.classList.remove("streaming");
  }
}

/** A new conversation was created for this message: select it and add it to the sidebar. */
function adoptNewConversation(id, firstMessage) {
  state.currentId = id;
  history.replaceState(null, "", `#c=${id}`);
  state.conversations.unshift({
    id,
    title: null,
    preview: firstMessage.slice(0, 80),
    updated_at: Date.now(),
  });
  renderSidebar();
}

function applyTitle({ conversationId, title }) {
  const conversation = state.conversations.find((c) => c.id === conversationId);
  if (conversation) conversation.title = title;
  if (state.currentId === conversationId) setPageTitle(title);
  renderSidebar();
}

function handleChatEvent(event, pending, messageText) {
  switch (event.type) {
    case "conversation":
      if (event.created) adoptNewConversation(event.id, messageText);
      break;
    case "status":
      pending.setStatus(event.text);
      scrollToBottom();
      break;
    case "text":
      pending.appendText(event.delta);
      break;
    case "sources":
      pending.sources = event.sources;
      break;
    case "done":
      pending.complete(event);
      scrollToBottom();
      // The answer is in: let the user type the next message while the title arrives.
      setStreaming(null);
      break;
    case "title":
      applyTitle(event);
      break;
    case "error":
      pending.showError(event.message);
      break;
  }
}

// ── Sending ────────────────────────────────────────────────────────

export async function send(rawText) {
  const text = rawText.trim();
  if (!text || state.streaming) return;

  hideBanner();
  els.input.value = "";
  autosize();

  showThread(true);
  els.messages.append(userMessageElement(text, Date.now()));
  const pending = new PendingAnswer();
  els.messages.append(pending.element);
  scrollToBottom(true);

  const controller = new AbortController();
  setStreaming(controller);

  try {
    const response = await postChat(
      { conversationId: state.currentId, message: text, timezone },
      controller.signal,
    );
    await readSseEvents(response, (event) => handleChatEvent(event, pending, text));
    if (!pending.finished) throw new Error("The connection closed before the answer finished.");

    // Refresh order and timestamps.
    loadConversations().then(() => renderSuggestions(send));
  } catch (error) {
    pending.fail(error);
  } finally {
    if (state.streaming === controller) setStreaming(null);
  }
}
