/**
 * Renders answers: markdown → sanitized HTML, with [n] citations turned into links to source n.
 */
import { marked } from "/vendor/marked.js";
import DOMPurify from "/vendor/purify.js";

marked.setOptions({ gfm: true, breaks: false });

// Every link in an answer opens in a new tab.
DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A" && node.getAttribute("href")) {
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener noreferrer");
  }
});

export function renderMarkdown(element, text, sources) {
  element.innerHTML = DOMPurify.sanitize(marked.parse(text));
  if (sources?.length) linkCitations(element, sources);
}

const CITATION = /\[(\d+)\]/g;

/** Text nodes that contain a citation and aren't inside code or an existing link. */
function citationTextNodes(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => {
      const hasCitation = /\[\d+\]/.test(node.nodeValue);
      const inCodeOrLink = node.parentElement.closest("code, pre, a");
      return hasCitation && !inCodeOrLink ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    },
  });
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  return nodes;
}

function citationLink(source, label) {
  const link = document.createElement("a");
  link.className = "cite";
  link.href = source.url;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.title = source.title;
  link.textContent = label;
  return link;
}

/** Turns [n] in the text (outside code and links) into small links to source n. */
function linkCitations(root, sources) {
  const sourceByNumber = new Map(sources.map((source) => [source.n, source]));

  for (const node of citationTextNodes(root)) {
    const text = node.nodeValue;
    const fragment = document.createDocumentFragment();
    let lastEnd = 0;

    for (const match of text.matchAll(CITATION)) {
      const source = sourceByNumber.get(Number(match[1]));
      if (!source) continue;
      fragment.append(text.slice(lastEnd, match.index), citationLink(source, match[1]));
      lastEnd = match.index + match[0].length;
    }

    if (lastEnd === 0) continue; // no known citation in this node
    fragment.append(text.slice(lastEnd));
    node.replaceWith(fragment);
  }
}
