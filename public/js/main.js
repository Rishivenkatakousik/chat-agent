/**
 * Minimi web client entry point: wires up the buttons and keyboard, keeps the open conversation
 * in the URL (#c=<id>), and loads the first screen. No build step: these are native ES modules.
 */
import { api } from "./api.js";
import {
  autosize,
  newChat,
  openConversation,
  renderSuggestions,
  send,
  updateSendEnabled,
} from "./chat-view.js";
import { closeNav, els, openNav, showBanner, state } from "./page.js";
import { initSidebar, loadConversations } from "./sidebar.js";

/** Warns early when the server is missing an API key or isn't running. */
async function checkHealth() {
  try {
    const health = await api("/api/health");
    if (!health.ok) {
      showBanner(
        `The server is missing ${health.missingKeys.join(" and ")}. Add it to .env and restart the server.`,
      );
    }
  } catch {
    showBanner("Can't reach the server. Is `npm run dev` running?");
  }
}

/** Opens the conversation named in the URL hash, or a new chat when there is none. */
function route() {
  const id = new URLSearchParams(location.hash.slice(1)).get("c");
  if (id && id !== state.currentId) openConversation(id);
  else if (!id && state.currentId && !state.streaming) newChat();
}

function bindEvents() {
  els.input.addEventListener("input", autosize);
  els.input.addEventListener("keydown", (event) => {
    // Enter sends; Shift+Enter (or an IME composition) adds a newline.
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      send(els.input.value);
    }
  });
  els.form.addEventListener("submit", (event) => {
    event.preventDefault();
    send(els.input.value);
  });
  els.stop.addEventListener("click", () => state.streaming?.abort());
  els.newChat.addEventListener("click", newChat);
  els.menuBtn.addEventListener("click", openNav);
  els.scrim.addEventListener("click", closeNav);
  window.addEventListener("hashchange", route);
}

initSidebar({ onOpenConversationDeleted: newChat });
bindEvents();
checkHealth();
await loadConversations();
renderSuggestions(send);
route();
updateSendEnabled();
els.input.focus();
