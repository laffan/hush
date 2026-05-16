/**
 * Zen Focus — fullscreen distraction-free overlay.
 *
 * Picks the prose surface the user is currently working with (notebook
 * text shape > active doc pane > main editor), reads its content +
 * cursor position, and mounts a freshly-built CodeMirror editor inside
 * the Zen overlay seeded with that state. The source editor is
 * untouched while Zen is open. On exit the new content + selection
 * are pushed back to the source.
 *
 * The shadow-editor approach sidesteps every flavour of bug we hit
 * with the previous DOM-reparent design: there's no measure-cycle
 * staleness (the new editor is born at the right size), no fight with
 * the pane click-outside-deactivate handler, and no need for textarea
 * mirror geometry — the notebook text shape gets a real CodeMirror
 * for the duration of Zen, with the value flowed back on exit.
 */

import { EditorView } from "@codemirror/view";
import { EditorState, EditorSelection } from "@codemirror/state";
import { createBaseExtensions } from "./editor.js";
import { createFocusModePlugin } from "./plugins/focus-mode.js";
import { createProjectViewField, createSeparatorFilter } from "./plugins/project-view.js";
import { panes } from "../pane/pane-state.js";
import { getActivePaneId } from "../pane/pane-manager.js";

let active = null;
let hintFadeTimer = null;

const HINT_FADE_MS = 1500;

export function initZenFocus(state) {
  state.on("zen-focus-changed", () => {
    if (state.zenFocus) enterZenFocus(state);
    else exitZenFocus(state);
  });
  state.on("settings-changed", () => {
    if (!active || !active.overlay) return;
    const px = state.settings.zenFocusFontSize || 30;
    active.overlay.style.setProperty("--zen-font-size", `${px}px`);
  });
}

/** Find the prose surface to seed the Zen editor from. Priority:
 *  notebook text-shape editor > active doc pane editor > main editor.
 *  Returns null if there's nothing prose-shaped to focus on. */
function pickZenSource(state) {
  const nbHandle = (typeof window !== "undefined")
    ? window.__activeNotebookTextEditor : null;
  if (nbHandle && nbHandle.textarea && document.contains(nbHandle.textarea)) {
    return { kind: "notebook-text", handle: nbHandle };
  }
  const paneId = getActivePaneId();
  if (paneId) {
    const pane = panes.get(paneId);
    if (pane && pane.fileType === "document" && pane.editor?.view) {
      return { kind: "pane", pane };
    }
  }
  if (!state.currentNotebookFileId && state.editor?.view) {
    return { kind: "main", view: state.editor.view };
  }
  return null;
}

/** Snapshot the source's content + selection to seed the Zen editor. */
function readSeed(source) {
  if (source.kind === "main") {
    const v = source.view;
    const sel = v.state.selection.main;
    return { content: v.state.sliceDoc(), anchor: sel.anchor, head: sel.head };
  }
  if (source.kind === "pane") {
    const v = source.pane.editor.view;
    const sel = v.state.selection.main;
    return { content: v.state.sliceDoc(), anchor: sel.anchor, head: sel.head };
  }
  // notebook-text
  const ta = source.handle.textarea;
  return {
    content: ta.value || "",
    anchor: ta.selectionStart || 0,
    head: ta.selectionEnd || 0,
  };
}

/** Push the Zen editor's final content + selection back to the source.
 *  For CM sources we dispatch a single replacement transaction so undo
 *  history stays sensible; for the textarea we set value, selection,
 *  and fire `input` so text-editor.ts's state-update path runs. */
function writeBack(source, content, anchor, head) {
  if (source.kind === "main") {
    const v = source.view;
    const len = v.state.doc.length;
    const a = clamp(anchor, 0, content.length);
    const h = clamp(head, 0, content.length);
    v.dispatch({
      changes: { from: 0, to: len, insert: content },
      selection: { anchor: a, head: h },
    });
    // Zen always centres the cursor; on exit, replacing the whole doc
    // would otherwise leave the editor scrolled to the top. Recentre
    // here (and again on the next two frames — CM settles its measure
    // pass asynchronously) so the user returns to roughly where they
    // were writing.
    centerCursor(v, h);
    v.focus();
    return;
  }
  if (source.kind === "pane") {
    const v = source.pane.editor.view;
    const len = v.state.doc.length;
    const a = clamp(anchor, 0, content.length);
    const h = clamp(head, 0, content.length);
    v.dispatch({
      changes: { from: 0, to: len, insert: content },
      selection: { anchor: a, head: h },
    });
    centerCursor(v, h);
    v.focus();
    return;
  }
  const ta = source.handle.textarea;
  ta.value = content;
  ta.selectionStart = clamp(anchor, 0, content.length);
  ta.selectionEnd = clamp(head, 0, content.length);
  // text-editor.ts's input handler reads textarea.value and updates
  // state.editingText — fire the event so its measurement / commit
  // path stays in sync with the post-Zen value.
  ta.dispatchEvent(new Event("input", { bubbles: true }));
  ta.focus();
}

function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n | 0)); }

function centerCursor(view, pos) {
  const dispatchCenter = () => {
    try {
      view.dispatch({ effects: EditorView.scrollIntoView(pos, { y: "center" }) });
    } catch (_) { /* view destroyed */ }
  };
  dispatchCenter();
  requestAnimationFrame(dispatchCenter);
  setTimeout(dispatchCenter, 60);
}

export function enterZenFocus(state) {
  if (active) return;
  const source = pickZenSource(state);
  if (!source) {
    state.zenFocus = false;
    return;
  }
  const seed = readSeed(source);

  // Build overlay shell.
  const overlay = document.createElement("div");
  overlay.className = "zen-focus-overlay";
  overlay.style.setProperty("--zen-font-size", `${state.settings.zenFocusFontSize || 30}px`);

  const stage = document.createElement("div");
  stage.className = "zen-focus-stage";
  overlay.appendChild(stage);

  const hint = document.createElement("div");
  hint.className = "zen-focus-hint";
  hint.textContent = formatShortcutForHint(state.settings.shortcutZenFocus || "Mod+Shift+S");
  overlay.appendChild(hint);

  // Auto-enable focus mode (only the active sentence is fully visible —
  // the rest dims to 50% via --focus-mode-opacity overridden in CSS).
  const wasFocusMode = state.focusMode;
  if (!wasFocusMode) {
    state.focusMode = true;
    state.emit("mode-changed");
  }

  document.body.classList.add("zen-focus-active");
  document.body.appendChild(overlay);

  // Build the Zen shadow editor. createBaseExtensions covers markdown,
  // callouts, links, etc. — but it intentionally omits focus mode (and
  // a few other doc-only plugins) because panes don't need them.
  // Zen *does* want sentence-level dim, so we add focus mode here on
  // top of the base set.
  const { extensions } = createBaseExtensions(state, () => { /* no per-keystroke sync */ });
  // Recentre on every selection / doc / viewport change. CodeMirror's
  // own scrollIntoView effect handles measurement timing — far more
  // reliable than computing scrollTop ourselves before CM has settled.
  const recentre = EditorView.updateListener.of((u) => {
    if (u.selectionSet || u.docChanged || u.viewportChanged) {
      const head = u.state.selection.main.head;
      u.view.dispatch({ effects: EditorView.scrollIntoView(head, { y: "center" }) });
    }
  });
  const editorState = EditorState.create({
    doc: seed.content,
    selection: EditorSelection.range(
      clamp(seed.anchor, 0, seed.content.length),
      clamp(seed.head,   0, seed.content.length),
    ),
    extensions: [
      ...extensions,
      createFocusModePlugin(state),
      // Replace the raw `---hush-separator---` line with the dashed
      // block widget so project-view zens look like the main editor.
      // The separator filter rides along so accidental keystrokes can't
      // delete or duplicate one inside Zen.
      createProjectViewField(state),
      createSeparatorFilter(state),
      recentre,
    ],
  });
  const zenView = new EditorView({ state: editorState, parent: stage });

  const onKeydown = (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      state.toggleZenFocus();
    }
  };
  const onMouseMove = () => showHint(hint);
  document.addEventListener("keydown", onKeydown, true);
  overlay.addEventListener("mousemove", onMouseMove);

  // The shadow editor's update-driven plugins (focus mode, in
  // particular) only rebuild on its own transactions. Forward
  // mode-changed to the zen view via a no-op dispatch so toggling
  // focus mode (Cmd+Shift+Y) inside Zen actually re-renders the
  // dim decorations — matches what the main editor's mode-changed
  // handler does for its view.
  const onModeChanged = () => {
    if (!active || !active.zenView) return;
    active.zenView.dispatch({ effects: [] });
  };
  state.on("mode-changed", onModeChanged);

  zenView.focus();

  // Initial scroll-to-cursor — CM dispatches the effect, which may
  // settle on the next measure cycle. The rAF tail covers the case
  // where the first dispatch happens before initial layout.
  const initialScroll = () => {
    if (!active) return;
    zenView.dispatch({
      effects: EditorView.scrollIntoView(zenView.state.selection.main.head, { y: "center" }),
    });
  };
  initialScroll();
  requestAnimationFrame(initialScroll);
  setTimeout(initialScroll, 60);

  showHint(hint);

  active = {
    source,
    zenView,
    overlay,
    hint,
    onKeydown,
    onMouseMove,
    onModeChanged,
    wasFocusMode,
  };
}

export function exitZenFocus(state) {
  if (!active) return;
  const a = active;
  active = null;

  // Snapshot final content + selection before tearing down the editor.
  const finalContent = a.zenView.state.doc.toString();
  const finalSel = a.zenView.state.selection.main;

  document.removeEventListener("keydown", a.onKeydown, true);
  a.overlay.removeEventListener("mousemove", a.onMouseMove);
  if (a.onModeChanged) state.off("mode-changed", a.onModeChanged);
  if (hintFadeTimer) { clearTimeout(hintFadeTimer); hintFadeTimer = null; }

  a.zenView.destroy();
  a.overlay.remove();
  document.body.classList.remove("zen-focus-active");

  if (!a.wasFocusMode && state.focusMode) {
    state.focusMode = false;
    state.emit("mode-changed");
  }

  writeBack(a.source, finalContent, finalSel.anchor, finalSel.head);
}

export function toggleZenFocus(state) {
  state.toggleZenFocus();
}

function showHint(hint) {
  hint.classList.add("visible");
  if (hintFadeTimer) clearTimeout(hintFadeTimer);
  hintFadeTimer = setTimeout(() => {
    hint.classList.remove("visible");
    hintFadeTimer = null;
  }, HINT_FADE_MS);
}

/** Render a shortcut string like "Mod+Shift+S" with platform glyphs. */
function formatShortcutForHint(shortcut) {
  const isMac = typeof navigator !== "undefined" && /mac/i.test(navigator.platform || "");
  const parts = String(shortcut || "").split("+").map((p) => p.trim()).filter(Boolean);
  return parts.map((p) => {
    const key = p.toLowerCase();
    if (key === "mod" || key === "cmdorctrl") return isMac ? "⌘" : "Ctrl";
    if (key === "cmd") return isMac ? "⌘" : "Win";
    if (key === "ctrl") return "Ctrl";
    if (key === "alt" || key === "option") return isMac ? "⌥" : "Alt";
    if (key === "shift") return "⇧";
    return p.length === 1 ? p.toUpperCase() : p;
  }).join(isMac ? "" : "+") + "  to exit";
}
