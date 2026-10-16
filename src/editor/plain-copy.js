/**
 * Copied text that merely *starts* like a URL leaves as text only.
 *
 * WebKit vends a URL representation beside the plain text whenever the
 * copied string parses as an absolute URL — and any `word:` opening
 * does: a card beginning "Method: …" was put on the pasteboard as the
 * URL `method:%20%0A%0A--%20which…` too, and an app that prefers URLs
 * pasted that, lowercased scheme, percent-encoded spaces and line breaks
 * and all. The words themselves can't be changed, so after CodeMirror
 * writes the copy, such a string is written again through the native
 * clipboard as plain text alone, which replaces the URL flavour.
 *
 * Only for a string with whitespace inside it, which no URL has; a real
 * link copied on its own keeps its URL flavour. In both extension lists
 * (editor.js, base-extensions.js), so cards, panes and the Doc agree.
 */
import { EditorView } from "@codemirror/view";
import { Prec } from "@codemirror/state";

const IS_TAURI = typeof window !== "undefined" && window.__TAURI_INTERNALS__ != null;

/** Plain text only, through NSPasteboard / UIPasteboard directly. */
async function writePlainText(text) {
  if (IS_TAURI) {
    try {
      const { writeText } = await import("@tauri-apps/plugin-clipboard-manager");
      await writeText(text);
      return;
    } catch (_) { /* fall through */ }
  }
  try { await navigator.clipboard.writeText(text); } catch (_) { /* clipboard unavailable */ }
}

const SCHEME_LIKE = /^[A-Za-z][A-Za-z0-9+.-]*:/;

/** True for text WebKit would also offer as a URL that isn't one. */
export function looksLikeFalseUrl(text) {
  const t = (text || "").trim();
  return SCHEME_LIKE.test(t) && /\s/.test(t);
}

export function createPlainCopy() {
  // The text CodeMirror is about to put on the clipboard, as the output
  // filters leave it (this one runs last, at Prec.lowest). A drag of the
  // selection runs the filters too, so it is only acted on from a
  // copy / cut event below.
  let pending = null;
  return [
    Prec.lowest(EditorView.clipboardOutputFilter.of((text) => { pending = text; return text; })),
    EditorView.domEventHandlers({
      copy: () => { scheduleRewrite(); return false; },
      cut: () => { scheduleRewrite(); return false; },
    }),
  ];
  function scheduleRewrite() {
    pending = null;
    // After the event: CodeMirror's own copy handler runs after this one
    // and fills `pending`, and the platform writes the pasteboard once
    // the event is over.
    setTimeout(() => {
      const text = pending;
      pending = null;
      if (text && looksLikeFalseUrl(text)) void writePlainText(text);
    }, 0);
  }
}
