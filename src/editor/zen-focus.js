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
import { createBaseExtensions } from "./base-extensions.js";
import { createFocusModePlugin } from "./plugins/focus-mode.js";
import { createProjectViewField, createSeparatorFilter } from "./plugins/project-view.js";
import { applyBlockCursor } from "./block-cursor.js";
import { bindLineIndicatorToContainer } from "./line-indicator.js";
import { panes } from "../pane/pane-state.js";
import { getActivePaneId } from "../pane/pane-manager.js";
import { getStackInstance } from "../stack/stack-bridge.js";

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
 *  notebook text-shape editor > active stack column > active doc pane
 *  editor > main editor.
 *  Returns null if there's nothing prose-shaped to focus on. */
function pickZenSource(state) {
  const nbHandle = (typeof window !== "undefined")
    ? window.__activeNotebookTextEditor : null;
  if (nbHandle && nbHandle.textarea && document.contains(nbHandle.textarea)) {
    return { kind: "notebook-text", handle: nbHandle };
  }
  if (state.currentStackFileId) {
    const stackView = getActiveStackEditorView(state);
    if (stackView) return { kind: "stack", view: stackView };
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

function getActiveStackEditorView() {
  try {
    const inst = getStackInstance();
    if (!inst) return null;
    const item = inst.getActiveItem();
    if (!item) return null;
    if (item.fileType !== "document" && item.fileType !== "project") return null;
    const liveData = inst._liveColumns.get(item.id);
    return liveData?.editor?.view || null;
  } catch (_) { return null; }
}

/** Snapshot the source's content + selection to seed the Zen editor. */
function readSeed(source) {
  if (source.kind === "main" || source.kind === "stack") {
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
  if (source.kind === "main" || source.kind === "stack") {
    const v = source.view;
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

/** Read the configured Zen Focus window (1, 3, 5, or 7). Any other
 *  value is coerced to the nearest legal option so a stray setting
 *  can't break the scroll math. */
function getZenWindow(state) {
  const raw = state?.settings?.zenFocusWindow;
  if (raw === 3) return 3;
  if (raw === 5) return 5;
  if (raw === 7) return 7;
  return 1;
}

/** Keep the cursor within an N-line band centred on the viewport.
 *  Window=1 collapses to typewriter (cursor pinned to centre line).
 *  Window=3 / 5 leave the cursor untouched until it would land outside
 *  the band, then scroll just enough to nudge it back to the edge of
 *  the band. Math runs in viewport (screen) coordinates via
 *  `view.coordsAtPos` — the previous implementation mixed CodeMirror's
 *  content-relative `block.top` with the scroller's scrollTop and got
 *  caught out by the 50vh top/bottom padding the Zen scroller wears
 *  (that padding offsets every content-y by half a viewport, so the
 *  cursor was being scrolled off-screen as soon as it left the centre
 *  line). */
function maintainTypewriterWindow(view, state) {
  try {
    const head = view.state.selection.main.head;
    const winSize = getZenWindow(state);
    if (winSize <= 1) {
      // Pure typewriter — defer to CodeMirror's scrollIntoView so the
      // measure timing matches the original behaviour exactly.
      view.dispatch({ effects: EditorView.scrollIntoView(head, { y: "center" }) });
      return;
    }
    const coords = view.coordsAtPos(head);
    if (!coords) {
      // Cursor not in the rendered viewport — CM hasn't measured the
      // target line yet. Fall back to centring; the next update (after
      // CM's measure pass) will land inside the windowed branch.
      view.dispatch({ effects: EditorView.scrollIntoView(head, { y: "center" }) });
      return;
    }
    const scroller = view.scrollDOM;
    const sRect = scroller.getBoundingClientRect();
    if (!sRect.height) return;
    const lineH = (typeof view.defaultLineHeight === "number" && view.defaultLineHeight > 0)
      ? view.defaultLineHeight
      : Math.max(1, coords.bottom - coords.top);
    const halfBand = ((winSize - 1) / 2) * lineH;
    const cursorMid = (coords.top + coords.bottom) / 2;
    const viewportCentre = (sRect.top + sRect.bottom) / 2;
    const offset = cursorMid - viewportCentre;
    if (Math.abs(offset) <= halfBand) return;
    // Cursor outside the band — scroll just enough to put it on the
    // matching band edge (top edge if it walked up, bottom edge if it
    // walked down).
    const delta = offset > 0 ? offset - halfBand : offset + halfBand;
    scroller.scrollTop = scroller.scrollTop + delta;
  } catch (_) { /* view destroyed mid-update — ignore */ }
}

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

  // Paint the cursor mode (system / block / underline) onto the freshly
  // mounted overlay. The same call refreshes the main editor too, but
  // it's the overlay that needs it — Zen mounts its CodeMirror outside
  // `#editor-container` so the cursor CSS wouldn't otherwise reach it.
  applyBlockCursor(state);
  // Same story for the line indicator: `createBaseExtensions` brings the
  // overlay-drawing plugin, but the variant skin is a `line-ind-*` class
  // on a container, and Zen's CodeMirror lives outside `#editor-container`
  // where nothing had put one. Without this the indicator drew and
  // stayed invisible.
  const unbindLineIndicator = bindLineIndicatorToContainer(overlay, state);

  // Build the Zen shadow editor. createBaseExtensions covers markdown,
  // callouts, links, etc. — but it intentionally omits focus mode (and
  // a few other doc-only plugins) because panes don't need them.
  // Zen *does* want sentence-level dim, so we add focus mode here on
  // top of the base set.
  const { extensions } = createBaseExtensions(state, () => { /* no per-keystroke sync */ });
  // Cursor follows a configurable typewriter window. Window=1 keeps
  // the cursor pinned to the centre line (the existing behaviour);
  // larger odd values (3, 5) let it drift `(window-1)/2` lines either
  // side of centre before the document scrolls underneath it.
  const recentre = EditorView.updateListener.of((u) => {
    if (u.selectionSet || u.docChanged || u.viewportChanged) {
      maintainTypewriterWindow(u.view, state);
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

  // The freshly-built Zen editor includes the active theme, whose
  // extension paints its own `.cm-editor` foreground. When the active
  // style overrides the text colour, the main editor pins that override
  // inline on its own `.cm-editor` (see applyActiveStyle); mirror it here
  // so Zen text matches instead of falling back to the theme's stock fg.
  const styleFg = getComputedStyle(document.documentElement)
    .getPropertyValue("--style-fg").trim();
  if (styleFg) zenView.dom.style.color = styleFg;

  // Column resizers — mirror the main editor's cmd-held grip handles
  // so the user can re-flow Zen's column width without leaving the
  // overlay. Writes through to `state.settings.columnWidth` so the
  // change carries over when Zen closes.
  const zenResizerCleanup = installZenResizers(state, overlay, stage);

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

  // Initial scroll-to-cursor — always centre on entry regardless of
  // the configured window so the user lands at a predictable spot.
  // Subsequent updates honour the window via maintainTypewriterWindow.
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
    zenResizerCleanup,
    unbindLineIndicator,
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

  if (a.zenResizerCleanup) { try { a.zenResizerCleanup(); } catch (_) {} }
  if (a.unbindLineIndicator) a.unbindLineIndicator();
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

/** Install two column-resizers inside the Zen overlay. They share the
 *  main editor's `columnWidth` setting so resizing in either context
 *  affects the other on subsequent visits. The handles are mounted
 *  inside `overlay` (not body) so they tear down with the overlay.
 *  Returns a cleanup function to remove the global listeners. */
function installZenResizers(state, overlay, stage) {
  const left = document.createElement("div");
  left.className = "column-resizer left";
  const right = document.createElement("div");
  right.className = "column-resizer right";
  overlay.appendChild(left);
  overlay.appendChild(right);

  let hideTimeout = null;
  const showBoth = () => {
    clearTimeout(hideTimeout);
    left.classList.add("hover");
    right.classList.add("hover");
  };
  const hideBoth = () => {
    hideTimeout = setTimeout(() => {
      left.classList.remove("hover");
      right.classList.remove("hover");
    }, 200);
  };
  left.addEventListener("mouseenter", showBoth);
  left.addEventListener("mouseleave", hideBoth);
  right.addEventListener("mouseenter", showBoth);
  right.addEventListener("mouseleave", hideBoth);

  function readZenWidth() {
    const z = Number(state.settings.zenColumnWidth);
    if (Number.isFinite(z) && z > 0) return z;
    return Number(state.settings.columnWidth) || 800;
  }

  function applyLayout() {
    const w = overlay.clientWidth || window.innerWidth;
    const colW = Math.max(200, Math.min(w - 40, readZenWidth()));
    const sidePad = Math.max(20, Math.floor((w - colW) / 2));
    // Drive the stage width directly so changes from the resizers
    // apply instantly without depending on a global CSS-var update.
    // Plus the gutter the stage reserves either side for the line
    // indicator's margin marks — `colW` is the *text* measure, and the
    // scroller's padding would otherwise eat it (zen-focus.css).
    stage.style.width = `calc(${colW}px + 2 * var(--overlay-gutter, 28px))`;
    // Position the resizers 10 px outside the stage's edges to match
    // the main editor's resizer geometry.
    left.style.left = (sidePad - 10) + "px";
    right.style.left = (w - sidePad + 10) + "px";
  }
  applyLayout();
  const onResize = () => applyLayout();
  window.addEventListener("resize", onResize);

  function makeDraggable(el, isLeft) {
    el.addEventListener("mousedown", (e) => {
      e.preventDefault();
      const startX = e.clientX;
      const startWidth = readZenWidth();
      el.classList.add("dragging");
      showBoth();

      function onMove(e2) {
        const delta = isLeft ? startX - e2.clientX : e2.clientX - startX;
        const newWidth = Math.max(300, Math.min(window.innerWidth - 100, startWidth + delta * 2));
        // Update in-memory only during the drag — settings.zenColumnWidth
        // gets persisted on pointerup so the autosave + sync paths don't
        // fire on every pixel.
        state.settings.zenColumnWidth = newWidth;
        applyLayout();
      }
      function onUp() {
        el.classList.remove("dragging");
        hideBoth();
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        state.updateSettings({ zenColumnWidth: state.settings.zenColumnWidth });
      }
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    });
  }
  makeDraggable(left, true);
  makeDraggable(right, false);

  return () => {
    window.removeEventListener("resize", onResize);
    clearTimeout(hideTimeout);
  };
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
