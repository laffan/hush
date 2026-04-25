import type { DrawingState } from "../state";
import { FONT_FAMILY, LINE_HEIGHT_RATIO } from "../types";
import { canvasToScreen } from "../utils";
import { h } from "./dom-helpers";

/**
 * Handle exposing minimal controls to outside callers (e.g. the Zotero
 * search modal). Set when a text-shape editor is actively open; cleared
 * on commit or end-editing. Used to let the modal suspend blur-commit
 * while it owns focus, then insert text back into the textarea.
 */
export interface ActiveNotebookTextEditor {
  textarea: HTMLTextAreaElement;
  state: DrawingState;
  suspendCommitOnBlur: () => void;
  resumeCommitOnBlur: () => void;
  insertAtSelection: (text: string) => void;
  focus: () => void;
}

let _activeNotebookTextEditor: ActiveNotebookTextEditor | null = null;

export function getActiveNotebookTextEditor(): ActiveNotebookTextEditor | null {
  return _activeNotebookTextEditor;
}

/** Mirror the active handle onto `window` so consumers that can't do an
 *  async `import()` before focus-stealing (e.g. the command palette,
 *  which needs to suspend commit-on-blur before its own input focuses)
 *  can reach it synchronously. */
function setActiveHandle(handle: ActiveNotebookTextEditor | null) {
  _activeNotebookTextEditor = handle;
  if (typeof window !== "undefined") {
    (window as unknown as { __activeNotebookTextEditor: ActiveNotebookTextEditor | null }).__activeNotebookTextEditor = handle;
  }
}

export function createTextEditor(state: DrawingState): HTMLElement {
  const container = h("div", { style: { position: "absolute", top: "0", left: "0", width: "0", height: "0", overflow: "visible", zIndex: "200", pointerEvents: "none" } });

  const measureDiv = h("div", {
    style: { position: "absolute", visibility: "hidden", height: "auto", width: "auto", padding: "0", border: "none", pointerEvents: "none", whiteSpace: "pre", wordBreak: "keep-all" },
    attrs: { "aria-hidden": "true" },
  });
  container.appendChild(measureDiv);

  const textarea = document.createElement("textarea");
  textarea.className = "inline-text-editor";
  Object.assign(textarea.style, {
    position: "absolute", background: "transparent", border: "none", outline: "none",
    padding: "0", margin: "0", resize: "none", overflow: "hidden",
    minWidth: "20px", zIndex: "200", boxSizing: "content-box",
    whiteSpace: "pre", wordBreak: "keep-all", pointerEvents: "auto", display: "none",
  });
  container.appendChild(textarea);

  // When a caller (e.g. the Zotero search modal) wants to temporarily
  // steal focus without triggering the commit-on-blur flow, they flip
  // `commitSuspended = true` and restore it when done.
  let commitSuspended = false;

  textarea.addEventListener("input", () => {
    if (!state.editingText) return;
    state.updateEditingText(textarea.value);
  });

  // In brainstorm mode, Enter commits text (Shift+Enter for newline)
  textarea.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && state.brainstormMode && state.editingText) {
      e.preventDefault();
      state.endEditingText();
      return;
    }
    // Markdown formatting shortcuts — mirror the main editor's defaults
    // so muscle memory works inside text shapes too.
    const mod = e.metaKey || e.ctrlKey;
    if (!mod || e.altKey) return;
    const key = e.key.toLowerCase();
    if (e.shiftKey) return;
    if (key === "b") { e.preventDefault(); applyTextareaWrap(textarea, state, "**"); return; }
    if (key === "i") { e.preventDefault(); applyTextareaWrap(textarea, state, "*"); return; }
    if (key === "=" || key === "+") { e.preventDefault(); applyTextareaWrap(textarea, state, "=="); return; }
    if (key === "k") { e.preventDefault(); applyTextareaLink(textarea, state); return; }
  });

  textarea.addEventListener("blur", () => {
    setTimeout(() => {
      if (!state.editingText) return;
      if (commitSuspended) return;
      state.endEditingText();
    }, 150);
  });

  const handle: ActiveNotebookTextEditor = {
    textarea,
    state,
    suspendCommitOnBlur: () => { commitSuspended = true; },
    resumeCommitOnBlur: () => { commitSuspended = false; },
    insertAtSelection: (text: string) => {
      if (!state.editingText) return;
      const start = textarea.selectionStart ?? textarea.value.length;
      const end = textarea.selectionEnd ?? textarea.value.length;
      const before = textarea.value.slice(0, start);
      const after = textarea.value.slice(end);
      const next = before + text + after;
      textarea.value = next;
      const caret = start + text.length;
      textarea.setSelectionRange(caret, caret);
      state.updateEditingText(next);
    },
    focus: () => {
      setTimeout(() => {
        textarea.focus();
        const pos = textarea.selectionEnd ?? textarea.value.length;
        textarea.setSelectionRange(pos, pos);
      }, 0);
    },
  };

  function update() {
    if (!state.editingText) {
      textarea.style.display = "none";
      if (_activeNotebookTextEditor === handle) setActiveHandle(null);
      commitSuspended = false;
      return;
    }
    // Register this editor as the globally-active notebook text editor so
    // outside callers (like the Zotero modal, the command palette) can
    // find it — both via the exported accessor and synchronously via
    // `window.__activeNotebookTextEditor`.
    setActiveHandle(handle);

    const et = state.editingText;
    const scaledFontSize = et.fontSize * state.camera.zoom;
    const scaledLineHeight = scaledFontSize * LINE_HEIGHT_RATIO;
    const screenPos = canvasToScreen(et.position, state.camera);

    const fontStyle = {
      fontFamily: `${state.fontFamily}, ${FONT_FAMILY}`,
      fontSize: scaledFontSize + "px",
      lineHeight: scaledLineHeight + "px",
    };

    Object.assign(measureDiv.style, fontStyle);
    const resolvedColor = et.color === "#000000" ? state.theme.foreground : et.color;
    const isEmpty = !et.text;
    Object.assign(textarea.style, fontStyle, {
      display: "block",
      left: screenPos.x + "px",
      top: screenPos.y + "px",
      color: resolvedColor,
      // Hide native caret when showing custom blinking border; show it once typing
      caretColor: isEmpty ? "transparent" : resolvedColor,
      minHeight: (scaledLineHeight + 4) + "px",
      // Blinking left border as cursor indicator when empty
      borderLeft: isEmpty ? `2px solid ${resolvedColor}` : "none",
      paddingLeft: isEmpty ? "2px" : "0",
    });
    textarea.classList.toggle("empty-cursor", isEmpty);

    // Sync value if different (avoid cursor jump)
    if (textarea.value !== et.text) textarea.value = et.text;

    // Auto-resize — respect width constraint if the shape has one
    const hasWidth = et.width && et.width > 0;
    const scaledWidth = hasWidth ? et.width! * state.camera.zoom : 0;

    if (hasWidth) {
      // Fixed width: textarea wraps within the shape's width
      textarea.style.whiteSpace = "pre-wrap";
      textarea.style.wordBreak = "break-word";
      textarea.style.width = scaledWidth + "px";
      measureDiv.style.whiteSpace = "pre-wrap";
      measureDiv.style.wordBreak = "break-word";
      measureDiv.style.width = scaledWidth + "px";
    } else {
      // Auto-width: grow with content
      textarea.style.whiteSpace = "pre";
      textarea.style.wordBreak = "keep-all";
      textarea.style.width = "auto";
      measureDiv.style.whiteSpace = "pre";
      measureDiv.style.wordBreak = "keep-all";
      measureDiv.style.width = "auto";
    }

    measureDiv.textContent = et.text || "\u00A0";
    if (et.text.endsWith("\n")) measureDiv.textContent += "\u00A0";

    if (!hasWidth) {
      textarea.style.width = (measureDiv.scrollWidth + 2) + "px";
    }
    textarea.style.height = measureDiv.scrollHeight + "px";

    // Focus with delay
    if (document.activeElement !== textarea) {
      setTimeout(() => {
        textarea.focus();
        textarea.setSelectionRange(textarea.value.length, textarea.value.length);
      }, 20);
    }
  }

  state.addEventListener("change", update);
  update();
  return container;
}

/** Toggle a paired marker (e.g. `**`, `*`, `==`) around the textarea's
 *  current selection. Mirrors the main editor's `toggleWrap` semantics:
 *  insert markers when nothing is selected, unwrap markers that already
 *  hug the selection (inside or outside), otherwise wrap. */
function applyTextareaWrap(textarea: HTMLTextAreaElement, state: DrawingState, marker: string) {
  const value = textarea.value;
  const start = textarea.selectionStart ?? value.length;
  const end = textarea.selectionEnd ?? value.length;
  const mLen = marker.length;

  let next: string;
  let caretStart: number;
  let caretEnd: number;

  if (start === end) {
    next = value.slice(0, start) + marker + marker + value.slice(end);
    caretStart = caretEnd = start + mLen;
  } else {
    const selected = value.slice(start, end);
    if (selected.startsWith(marker) && selected.endsWith(marker) && selected.length >= mLen * 2) {
      const inner = selected.slice(mLen, -mLen);
      next = value.slice(0, start) + inner + value.slice(end);
      caretStart = start;
      caretEnd = start + inner.length;
    } else {
      const before = value.slice(Math.max(0, start - mLen), start);
      const after = value.slice(end, end + mLen);
      if (before === marker && after === marker) {
        next = value.slice(0, start - mLen) + selected + value.slice(end + mLen);
        caretStart = start - mLen;
        caretEnd = end - mLen;
      } else {
        next = value.slice(0, start) + marker + selected + marker + value.slice(end);
        caretStart = start + mLen;
        caretEnd = end + mLen;
      }
    }
  }

  textarea.value = next;
  textarea.setSelectionRange(caretStart, caretEnd);
  if (state.editingText) state.updateEditingText(next);
}

/** Insert a `[text](url)` link at the current selection. With selected
 *  text, the URL placeholder is the selection target so the user can
 *  start typing it immediately; with no selection the cursor lands
 *  inside the empty `[]` so they can type the link text first. */
function applyTextareaLink(textarea: HTMLTextAreaElement, state: DrawingState) {
  const value = textarea.value;
  const start = textarea.selectionStart ?? value.length;
  const end = textarea.selectionEnd ?? value.length;
  const selected = value.slice(start, end);
  const URL_PLACEHOLDER = "url";
  const inserted = `[${selected}](${URL_PLACEHOLDER})`;
  const next = value.slice(0, start) + inserted + value.slice(end);
  textarea.value = next;

  if (selected.length === 0) {
    const caret = start + 1; // inside the empty [
    textarea.setSelectionRange(caret, caret);
  } else {
    const urlStart = start + 1 + selected.length + 2; // after "[selected]("
    const urlEnd = urlStart + URL_PLACEHOLDER.length;
    textarea.setSelectionRange(urlStart, urlEnd);
  }
  if (state.editingText) state.updateEditingText(next);
}
