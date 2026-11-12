/**
 * Generic DOM and formatting helpers. Nothing here knows about the app's state.
 */

/**
 * Creates an element: h("a", { class: "x", href, onclick }, "text", child).
 * `on*` props become event listeners; null/false props and children are skipped.
 */
export function h(tag, props = {}, ...children) {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false) continue;
    if (key === "class") element.className = value;
    else if (key.startsWith("on")) element.addEventListener(key.slice(2), value);
    else element.setAttribute(key, value === true ? "" : value);
  }
  element.append(...children.flat().filter((child) => child != null && child !== false));
  return element;
}

/** "https://www.neon.com/pricing" → "neon.com" */
export function domain(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/** "Tue 3 Nov, 10:30" in the browser's locale (with the year when it isn't this year). */
export function formatTime(ms) {
  const date = new Date(ms);
  const isThisYear = date.getFullYear() === new Date().getFullYear();
  return date.toLocaleString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    ...(isThisYear ? {} : { year: "numeric" }),
    hour: "2-digit",
    minute: "2-digit",
  });
}

const DAY_MS = 86_400_000;

/** Sidebar group for a timestamp: "Today", "Yesterday", "Previous 7 days", … */
export function dayGroup(ms) {
  const startOfDay = (date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const daysAgo = Math.round((startOfDay(new Date()) - startOfDay(new Date(ms))) / DAY_MS);
  if (daysAgo <= 0) return "Today";
  if (daysAgo === 1) return "Yesterday";
  if (daysAgo < 7) return "Previous 7 days";
  if (daysAgo < 30) return "Previous 30 days";
  return "Older";
}
