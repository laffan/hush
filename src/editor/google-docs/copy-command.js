/**
 * "Copy as Google Doc" + "Copy as HTML" commands. Both convert the current
 * selection (or the full document if nothing is selected) from markdown to
 * HTML — they differ only in *how* the result is written to the clipboard:
 *
 *   - Copy as Google Doc → writes the HTML as `text/html` (so Google Docs,
 *     Word, etc. interpret the formatting on paste) plus the original
 *     markdown as `text/plain` (for destinations that don't accept HTML).
 *   - Copy as HTML → writes the HTML *source* as `text/plain` so the user
 *     pastes the raw markup into a code editor, blog post draft, etc.
 *
 * Falls back to the legacy `document.execCommand("copy")` path with a
 * temporary contenteditable host when `navigator.clipboard.write` isn't
 * available — older WKWebViews ship without ClipboardItem.
 */
import { markdownToHtml } from "./markdown-to-html.js";

function selectionMarkdown(view) {
  const sel = view.state.selection.main;
  return sel.empty
    ? view.state.doc.toString()
    : view.state.sliceDoc(sel.from, sel.to);
}

export async function copyAsGoogleDoc(view) {
  if (!view) return;
  const md = selectionMarkdown(view);
  if (!md) return;
  const html = markdownToHtml(md);
  // Wrap in a minimal container so the clipboard MIME parsers don't get
  // confused by bare child elements on some platforms.
  const wrapped = `<meta charset="utf-8"><div>${html}</div>`;
  const ok = await writeClipboardRich(wrapped, md);
  if (ok) showCopyToast("Copied as Google Doc");
}

export async function copyAsHtml(view) {
  if (!view) return;
  const md = selectionMarkdown(view);
  if (!md) return;
  const html = markdownToHtml(md);
  const ok = await writeClipboardPlain(html);
  if (ok) showCopyToast("Copied as HTML");
}

async function writeClipboardRich(html, plain) {
  if (typeof window !== "undefined" && window.ClipboardItem && navigator.clipboard?.write) {
    try {
      const item = new ClipboardItem({
        "text/html": new Blob([html], { type: "text/html" }),
        "text/plain": new Blob([plain], { type: "text/plain" }),
      });
      await navigator.clipboard.write([item]);
      return true;
    } catch (e) {
      console.warn("[copy-as-google-doc] clipboard.write failed, falling back", e);
    }
  }
  return execCommandFallback(html);
}

async function writeClipboardPlain(text) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (e) {
      console.warn("[copy-as-html] writeText failed, falling back", e);
    }
  }
  return execCommandFallbackPlain(text);
}

function execCommandFallbackPlain(text) {
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    Object.assign(ta.style, {
      position: "fixed", top: "-10000px", left: "-10000px", opacity: "0",
    });
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch (e) {
    console.warn("[copy-as-html] execCommand fallback failed", e);
    return false;
  }
}

// Fallback for environments without ClipboardItem: stage the HTML inside
// a hidden contenteditable div, select it, and let `execCommand("copy")`
// pick up the rich content from the live DOM selection.
function execCommandFallback(html) {
  try {
    const host = document.createElement("div");
    host.contentEditable = "true";
    host.innerHTML = html;
    Object.assign(host.style, {
      position: "fixed", top: "-10000px", left: "-10000px",
      opacity: "0", pointerEvents: "none",
    });
    document.body.appendChild(host);
    const range = document.createRange();
    range.selectNodeContents(host);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    const ok = document.execCommand("copy");
    selection.removeAllRanges();
    host.remove();
    return ok;
  } catch (e) {
    console.warn("[copy-as-google-doc] execCommand fallback failed", e);
    return false;
  }
}

function showCopyToast(label) {
  document.querySelectorAll(".gdocs-copy-toast").forEach((el) => el.remove());
  const toast = document.createElement("div");
  // Reuses .style-locked-toast styling from styles-panel.css for consistency.
  toast.className = "style-locked-toast gdocs-copy-toast";
  toast.textContent = label;
  document.body.appendChild(toast);
  // Force reflow before adding the visible class so the transition fires.
  toast.offsetHeight; // eslint-disable-line no-unused-expressions
  toast.classList.add("visible");
  setTimeout(() => {
    toast.classList.remove("visible");
    setTimeout(() => toast.remove(), 300);
  }, 1500);
}
