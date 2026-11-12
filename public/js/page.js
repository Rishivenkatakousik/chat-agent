/**
 * Page-wide pieces shared by every other module: the DOM elements, the UI state, and small
 * helpers for the error banner, the page title and the mobile navigation drawer.
 */

const byId = (id) => document.getElementById(id);

export const els = {
  app: byId("app"),
  sidebar: byId("sidebar"),
  scrim: byId("scrim"),
  menuBtn: byId("menu-btn"),
  convList: byId("conv-list"),
  newChat: byId("new-chat"),
  title: byId("conv-title"),
  banner: byId("banner"),
  thread: byId("thread"),
  empty: byId("empty"),
  suggestions: byId("suggestions"),
  messages: byId("messages"),
  form: byId("composer"),
  input: byId("input"),
  send: byId("send"),
  stop: byId("stop"),
};

/** Sent with every message so the server resolves "last Tuesday" in the user's own timezone. */
export const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;

export const state = {
  /** Sidebar list: { id, title, preview, created_at, updated_at }. */
  conversations: [],
  /** Id of the open conversation; null for a new chat. */
  currentId: null,
  /** AbortController of the answer being streamed, if any. */
  streaming: null,
};

// ── Banner ─────────────────────────────────────────────────────────

export function showBanner(text) {
  els.banner.textContent = text;
  els.banner.hidden = false;
}

export function hideBanner() {
  els.banner.hidden = true;
}

// ── Title ──────────────────────────────────────────────────────────

export function setPageTitle(title) {
  els.title.textContent = title || "New chat";
  document.title = title ? `${title} · Minimi` : "Minimi";
}

// ── Mobile navigation ──────────────────────────────────────────────

export function openNav() {
  els.app.classList.add("nav-open");
  els.scrim.hidden = false;
}

export function closeNav() {
  els.app.classList.remove("nav-open");
  els.scrim.hidden = true;
}
