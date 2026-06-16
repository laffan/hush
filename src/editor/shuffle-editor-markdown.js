/**
 * Minimal markdown → HTML for Shuffle Editor nodes. Sentences render with
 * their formatting visible (so a shuffled selection reads like the prose it
 * came from) while the raw markdown is restored for editing.
 *
 * Supports: # / ## / ### headings, **bold**, *italic* / _italic_,
 * ~~strike~~, [text](url) links, ==highlight==, and ==FLAG== / ==FLAG: body==
 * callouts. Text is HTML-escaped first so node content can't inject markup.
 */

const FLAG_INNER_RE = /^([A-Za-z][A-Za-z0-9_-]{0,24})(?::([\s\S]*))?$/;

function esc(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Bold / italic / strike over an already-escaped string. */
function inlineBasic(s) {
  return s
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>")
    .replace(/_(.+?)_/g, "<em>$1</em>")
    .replace(/~~(.+?)~~/g, "<del>$1</del>");
}

function inlineMd(raw) {
  let s = esc(raw);
  // Links first so their bracket/paren syntax doesn't trip the later rules.
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<span class="shuffle-md-link">$1</span>');
  // Highlights / flags. A single-token inner (optionally `NAME: body`) reads
  // as a flag callout; anything else is a plain highlight. Mirrors the
  // notebook's `==…==` handling.
  s = s.replace(/==(.+?)==/g, (_m, inner) => {
    const flag = inner.match(FLAG_INNER_RE);
    if (flag) {
      const name = flag[1].toUpperCase();
      const body = flag[2] !== undefined ? `:${flag[2]}` : "";
      return `<span class="shuffle-md-flag">${name}${body}</span>`;
    }
    return `<span class="shuffle-md-highlight">${inner}</span>`;
  });
  return inlineBasic(s);
}

/** Render a node's markdown text to display HTML. */
export function renderShuffleMarkdown(text) {
  return String(text ?? "").split("\n").map((line) => {
    const h = line.match(/^(#{1,3})\s+(.*)$/);
    if (h) return `<span class="shuffle-md-h shuffle-md-h${h[1].length}">${inlineMd(h[2])}</span>`;
    return inlineMd(line);
  }).join("<br>");
}
