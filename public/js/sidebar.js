/**
 * The conversation list in the sidebar: loading, grouping by day, and two-step delete.
 */
import { api } from "./api.js";
import { dayGroup, h } from "./dom.js";
import { els, showBanner, state } from "./page.js";

/** How long the "Confirm" state of a delete button lasts. */
const CONFIRM_MS = 3000;

/** Called after the open conversation is deleted (set by main.js, to start a new chat). */
let onOpenConversationDeleted = () => {};

export function initSidebar(options) {
  onOpenConversationDeleted = options.onOpenConversationDeleted;
}

/** Sidebar label: the title, else the first question, else a placeholder. */
export function conversationLabel(conversation) {
  return conversation.title || conversation.preview || "New chat";
}

export async function loadConversations() {
  try {
    const { conversations } = await api("/api/conversations");
    state.conversations = conversations;
  } catch (error) {
    console.error(error);
  }
  renderSidebar();
}

export function renderSidebar() {
  els.convList.replaceChildren();
  if (state.conversations.length === 0) {
    els.convList.append(h("div", { class: "conv-empty" }, "No conversations yet."));
    return;
  }

  let currentGroup = null;
  for (const conversation of state.conversations) {
    const group = dayGroup(conversation.updated_at);
    if (group !== currentGroup) {
      currentGroup = group;
      els.convList.append(h("div", { class: "conv-group" }, group));
    }
    els.convList.append(conversationItem(conversation));
  }
}

function conversationItem(conversation) {
  const label = conversationLabel(conversation);
  const isActive = conversation.id === state.currentId;
  return h(
    "div",
    { class: `conv${isActive ? " active" : ""}`, "data-id": conversation.id },
    h(
      "a",
      { href: `#c=${conversation.id}`, class: conversation.title ? "" : "untitled", title: label },
      label,
    ),
    deleteButton(conversation.id),
  );
}

/** Two-step delete (click "Delete", then "Confirm") instead of a blocking confirm() dialog. */
function deleteButton(conversationId) {
  const button = h("button", { class: "del", type: "button", "aria-label": "Delete conversation" }, "Delete");
  let disarmTimer = null;

  const disarm = () => {
    disarmTimer = null;
    button.textContent = "Delete";
    button.classList.remove("confirm");
  };

  button.addEventListener("click", async (event) => {
    event.stopPropagation();
    if (!disarmTimer) {
      button.textContent = "Confirm";
      button.classList.add("confirm");
      disarmTimer = setTimeout(disarm, CONFIRM_MS);
      return;
    }
    clearTimeout(disarmTimer);
    await deleteConversation(conversationId);
  });
  return button;
}

async function deleteConversation(id) {
  try {
    await api(`/api/conversations/${id}`, { method: "DELETE" });
  } catch (error) {
    showBanner(error.message);
    return;
  }
  state.conversations = state.conversations.filter((conversation) => conversation.id !== id);
  if (state.currentId === id) onOpenConversationDeleted();
  else renderSidebar();
}
