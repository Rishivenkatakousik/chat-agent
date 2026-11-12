/**
 * Talking to the server: JSON requests, and reading the chat answer as a server-sent event stream.
 */

async function errorFrom(response) {
  const body = await response.json().catch(() => ({}));
  return new Error(body.error || `Request failed (${response.status})`);
}

/** JSON request; throws with the server's error message on failure. Resolves to null for 204. */
export async function api(path, options) {
  const response = await fetch(path, options);
  if (response.status === 204) return null;
  if (!response.ok) throw await errorFrom(response);
  return response.json();
}

/** Starts a chat turn. Resolves to the streaming response once the server has accepted it. */
export async function postChat(body, signal) {
  const response = await fetch("/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok) throw await errorFrom(response);
  return response;
}

/** Reads an SSE response body and calls `onEvent` with each event's JSON data. */
export async function readSseEvents(response, onEvent) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // Events are separated by a blank line.
    let end;
    while ((end = buffer.indexOf("\n\n")) >= 0) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const data = block
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice("data:".length).trimStart())
        .join("\n");
      if (data) onEvent(JSON.parse(data));
    }
  }
}
