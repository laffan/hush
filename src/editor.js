import { EditorView, keymap, drawSelection, placeholder } from "@codemirror/view";
import { EditorState, Prec, Compartment, Annotation } from "@codemirror/state";
import { markdown } from "@codemirror/lang-markdown";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags } from "@lezer/highlight";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { getActiveTheme } from "./themes.js";
import { createPrivateModePlugin } from "./private-mode.js";
import { openSettingsWindow } from "./settings-ui.js";

const themeCompartment = new Compartment();
const highlightCompartment = new Compartment();
const bypassRatchet = Annotation.define();

// Build the markdown highlight style, optionally normalizing heading sizes
function getMarkdownHighlight(normalizeHeaders) {
  const headingStyles = normalizeHeaders
    ? [
        { tag: tags.heading1, fontWeight: "700" },
        { tag: tags.heading2, fontWeight: "700" },
        { tag: tags.heading3, fontWeight: "600" },
        { tag: tags.heading4, fontWeight: "600" },
        { tag: tags.heading5, fontWeight: "600" },
        { tag: tags.heading6, fontWeight: "600" },
      ]
    : [
        { tag: tags.heading1, fontSize: "1.8em", fontWeight: "700", lineHeight: "1.3" },
        { tag: tags.heading2, fontSize: "1.5em", fontWeight: "700", lineHeight: "1.3" },
        { tag: tags.heading3, fontSize: "1.3em", fontWeight: "600", lineHeight: "1.3" },
        { tag: tags.heading4, fontSize: "1.15em", fontWeight: "600" },
        { tag: tags.heading5, fontSize: "1.05em", fontWeight: "600" },
        { tag: tags.heading6, fontSize: "1em", fontWeight: "600" },
      ];

  return HighlightStyle.define([
    ...headingStyles,
    { tag: tags.strong, fontWeight: "bold" },
    { tag: tags.emphasis, fontStyle: "italic" },
    { tag: tags.strikethrough, textDecoration: "line-through" },
    { tag: tags.link, textDecoration: "underline" },
    { tag: tags.url, textDecoration: "underline", opacity: "0.7" },
    { tag: tags.monospace, fontFamily: "'Fira Code', 'Consolas', monospace", fontSize: "0.9em" },
    // Dim the markdown syntax characters (# * _ ` etc.)
    { tag: tags.processingInstruction, opacity: "0.4" },
  ]);
}

/**
 * Creates the CodeMirror 6 editor instance.
 */
export function createEditor(container, state) {
  const updateListener = EditorView.updateListener.of((update) => {
    if (update.docChanged) {
      state.markDirty();
    }
    // Typewriter / Ratchet: scroll cursor to fixed position on every update
    const shouldScroll = state.typewriterMode || state.ratchetMode;
    if (shouldScroll && (update.docChanged || update.selectionSet)) {
      requestAnimationFrame(() => scrollCursorToTypewriterLine(update.view, state));
    }
    // Ratchet: ensure cursor stays at end of document
    if (state.ratchetMode && update.selectionSet) {
      const end = update.state.doc.length;
      const main = update.state.selection.main;
      if (main.anchor !== end || main.head !== end) {
        update.view.dispatch({ selection: { anchor: end } });
      }
    }
  });

  // Minimal theme
  const hushTheme = EditorView.theme({
    "&": {
      height: "100%",
    },
    ".cm-scroller": {
      fontFamily: "var(--font-family)",
      fontSize: "var(--font-size)",
      lineHeight: "var(--line-height)",
    },
    ".cm-content": {
      caretColor: "var(--cursor)",
      fontFamily: "var(--font-family)",
      padding: "0",
    },
    ".cm-cursor": {
      borderLeftColor: "var(--cursor)",
      borderLeftWidth: "2px",
    },
    ".cm-gutters": {
      display: "none",
    },
  });

  // Ratchet mode: block deletion, navigation, selection, undo
  const ratchetKeymap = Prec.highest(
    keymap.of([
      // Deletion
      { key: "Backspace", run: () => state.ratchetMode },
      { key: "Delete", run: () => state.ratchetMode },
      // All arrow navigation
      { key: "ArrowLeft", run: () => state.ratchetMode },
      { key: "ArrowRight", run: () => state.ratchetMode },
      { key: "ArrowUp", run: () => state.ratchetMode },
      { key: "ArrowDown", run: () => state.ratchetMode },
      { key: "Home", run: () => state.ratchetMode },
      { key: "End", run: () => state.ratchetMode },
      { key: "PageUp", run: () => state.ratchetMode },
      { key: "PageDown", run: () => state.ratchetMode },
      // Cmd+navigation
      { key: "Mod-ArrowLeft", run: () => state.ratchetMode },
      { key: "Mod-ArrowRight", run: () => state.ratchetMode },
      { key: "Mod-ArrowUp", run: () => state.ratchetMode },
      { key: "Mod-ArrowDown", run: () => state.ratchetMode },
      // Shift+arrow (selection)
      { key: "Shift-ArrowLeft", run: () => state.ratchetMode },
      { key: "Shift-ArrowRight", run: () => state.ratchetMode },
      { key: "Shift-ArrowUp", run: () => state.ratchetMode },
      { key: "Shift-ArrowDown", run: () => state.ratchetMode },
      { key: "Shift-Home", run: () => state.ratchetMode },
      { key: "Shift-End", run: () => state.ratchetMode },
      // Cmd+Shift+arrow (word/line selection)
      { key: "Mod-Shift-ArrowLeft", run: () => state.ratchetMode },
      { key: "Mod-Shift-ArrowRight", run: () => state.ratchetMode },
      { key: "Mod-Shift-ArrowUp", run: () => state.ratchetMode },
      { key: "Mod-Shift-ArrowDown", run: () => state.ratchetMode },
      // Select all, undo, redo, cut
      { key: "Mod-a", run: () => state.ratchetMode },
      { key: "Mod-z", run: () => state.ratchetMode },
      { key: "Mod-Shift-z", run: () => state.ratchetMode },
      { key: "Mod-x", run: () => state.ratchetMode },
    ])
  );

  // Global keyboard shortcuts
  const globalKeymap = Prec.highest(
    keymap.of([
      { key: "Mod-,", run: () => { openSettingsWindow(); return true; } },
      { key: "Mod-Shift-p", run: () => { state.togglePrivate(); return true; } },
      { key: "Mod-Shift-f", run: () => { state.toggleFullscreen(); return true; } },
      { key: "Mod-/", run: () => {
        const sidebar = document.getElementById("sidebar");
        const isPinned = sidebar.classList.toggle("pinned");
        if (isPinned) {
          sidebar.classList.add("visible");
        } else {
          sidebar.classList.remove("visible");
        }
        return true;
      }},
    ])
  );

  // Transaction filter: prevent deletions and non-end insertions in ratchet mode
  const ratchetFilter = EditorState.transactionFilter.of((tr) => {
    if (!state.ratchetMode || tr.annotation(bypassRatchet)) return tr;
    if (tr.docChanged) {
      let reject = false;
      tr.changes.iterChanges((fromA, toA) => {
        if (fromA < toA) reject = true; // deletion
        if (fromA !== tr.startState.doc.length) reject = true; // not appending at end
      });
      if (reject) return [];
    }
    return tr;
  });

  // Block mouse selection in ratchet mode
  const ratchetMouseFilter = EditorView.domEventHandlers({
    mousedown: () => state.ratchetMode,
  });

  // Resolve initial CM theme
  const activeTheme = getActiveTheme(state.settings);
  const initialCmTheme = activeTheme ? activeTheme.extension : [];

  const privateModePlugin = createPrivateModePlugin(state);

  const startState = EditorState.create({
    doc: "",
    extensions: [
      hushTheme,
      themeCompartment.of(initialCmTheme),
      highlightCompartment.of(syntaxHighlighting(getMarkdownHighlight(state.settings.normalizeHeaders))),
      markdown(),
      history(),
      drawSelection(),
      closeBrackets(),
      updateListener,
      globalKeymap,
      ratchetKeymap,
      ratchetFilter,
      ratchetMouseFilter,
      privateModePlugin,
      keymap.of([...defaultKeymap, ...historyKeymap, ...closeBracketsKeymap]),
      placeholder("Start writing..."),
      EditorView.lineWrapping,
    ],
  });

  const view = new EditorView({
    state: startState,
    parent: container,
  });

  // Mode changes
  state.on("mode-changed", () => {
    applyModes(state);
    updateRatchetTimer(state);
    // Force private mode decoration rebuild
    view.dispatch({ effects: [] });
    // When ratchet mode starts, move cursor to end and set up typewriter scrolling
    if (state.ratchetMode) {
      const end = view.state.doc.length;
      view.dispatch({ selection: { anchor: end }, annotations: bypassRatchet.of(true) });
      view.focus();
      applyRatchetTypewriterPadding(view);
      requestAnimationFrame(() => scrollCursorToTypewriterLine(view, state));
    } else {
      // Clean up ratchet typewriter padding (unless typewriter mode is on)
      if (!state.typewriterMode) {
        view.scrollDOM.style.paddingTop = "";
        view.scrollDOM.style.paddingBottom = "";
      }
    }
    if (state.typewriterMode) {
      setupTypewriterBoundary(view, state);
    } else {
      removeTypewriterBoundary(view, state);
    }
  });

  // Fullscreen
  state.on("fullscreen-changed", () => {
    applyFullscreen(state);
  });

  // Initialize column resizers
  updateColumnResizers(state);

  // Theme changes from settings
  state.on("theme-changed", () => {
    const t = getActiveTheme(state.settings);
    view.dispatch({ effects: themeCompartment.reconfigure(t ? t.extension : []) });
  });

  state.on("settings-changed", () => {
    // Apply font size / line height CSS vars
    document.documentElement.style.setProperty("--font-size", state.settings.fontSize + "px");
    document.documentElement.style.setProperty("--line-height", state.settings.lineHeight);
    // Reconfigure heading styles if normalizeHeaders changed
    view.dispatch({
      effects: highlightCompartment.reconfigure(
        syntaxHighlighting(getMarkdownHighlight(state.settings.normalizeHeaders))
      ),
    });
  });

  return {
    view,
    getContent: () => view.state.doc.toString(),
    setContent: (text) => {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: text },
        annotations: bypassRatchet.of(true),
      });
    },
    focus: () => view.focus(),
    reconfigureTheme: (ext) => {
      view.dispatch({ effects: themeCompartment.reconfigure(ext || []) });
    },
  };
}

function applyModes(state) {
  const app = document.getElementById("app");
  app.classList.toggle("ratchet-active", state.ratchetMode);
  app.classList.toggle("private-mode", state.privateMode);
  app.classList.toggle("typewriter-mode", state.typewriterMode);
}

async function applyFullscreen(state) {
  const app = document.getElementById("app");
  app.classList.toggle("fullscreen-mode", state.isFullscreen);

  const IS_TAURI = typeof window !== "undefined" && window.__TAURI_INTERNALS__;
  if (IS_TAURI) {
    try {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      const { invoke } = await import("@tauri-apps/api/core");
      const win = getCurrentWindow();

      // Switch to Regular activation policy so macOS shows our menu bar in fullscreen
      if (state.isFullscreen) {
        await invoke("set_activation_policy", { policy: "regular" });
      }

      try {
        await win.setSimpleFullscreen(state.isFullscreen);
      } catch (_) {
        await win.setFullscreen(state.isFullscreen);
      }

      if (!state.isFullscreen) {
        // Restore activation policy based on visibility setting
        const vis = state.settings.visibility;
        if (vis !== "dock" && vis !== "both") {
          await invoke("set_activation_policy", { policy: "accessory" });
        }
        // Apply always-on-top based on user setting
        await invoke("set_always_on_top", { onTop: !!state.settings.alwaysOnTop });
      }
    } catch (e) {
      console.error("Fullscreen toggle failed:", e);
    }
  }

  updateColumnResizers(state);
}

function updateColumnResizers(state) {
  // Clean up previous resizers and listeners
  document.querySelectorAll(".column-resizer").forEach((el) => el.remove());
  if (state._columnResizeHandler) {
    window.removeEventListener("resize", state._columnResizeHandler);
  }

  const leftResizer = document.createElement("div");
  leftResizer.className = "column-resizer left";
  const rightResizer = document.createElement("div");
  rightResizer.className = "column-resizer right";

  document.body.appendChild(leftResizer);
  document.body.appendChild(rightResizer);

  // When either resizer is hovered, show both (with a small delay on leave)
  let hideTimeout = null;
  function showBoth() {
    clearTimeout(hideTimeout);
    leftResizer.classList.add("hover");
    rightResizer.classList.add("hover");
  }
  function hideBoth() {
    hideTimeout = setTimeout(() => {
      leftResizer.classList.remove("hover");
      rightResizer.classList.remove("hover");
    }, 200);
  }
  leftResizer.addEventListener("mouseenter", showBoth);
  leftResizer.addEventListener("mouseleave", hideBoth);
  rightResizer.addEventListener("mouseenter", showBoth);
  rightResizer.addEventListener("mouseleave", hideBoth);

  function applyColumnLayout() {
    const w = window.innerWidth;
    const colW = state.settings.columnWidth;
    const minPad = 50;

    // Calculate side padding to center the column
    const sidePad = Math.max(minPad, Math.floor((w - colW) / 2));
    const showResizers = w > colW + minPad * 2;

    // Apply padding to the scroller for centering
    const scroller = document.querySelector("#editor-container .cm-scroller");
    if (scroller) {
      scroller.style.paddingLeft = sidePad + "px";
      scroller.style.paddingRight = sidePad + "px";
    }

    if (showResizers) {
      leftResizer.style.display = "";
      rightResizer.style.display = "";
      leftResizer.style.left = sidePad + "px";
      rightResizer.style.left = (w - sidePad) + "px";
    } else {
      leftResizer.style.display = "none";
      rightResizer.style.display = "none";
    }
  }

  applyColumnLayout();
  state._columnResizeHandler = applyColumnLayout;
  window.addEventListener("resize", applyColumnLayout);

  function makeDraggable(el, isLeft) {
    let startX, startWidth;
    el.addEventListener("mousedown", (e) => {
      e.preventDefault();
      startX = e.clientX;
      startWidth = state.settings.columnWidth;
      el.classList.add("dragging");

      function onMove(e2) {
        const delta = isLeft ? startX - e2.clientX : e2.clientX - startX;
        const newWidth = Math.max(300, Math.min(window.innerWidth - 100, startWidth + delta * 2));
        state.settings.columnWidth = newWidth;
        applyColumnLayout();
      }

      function onUp() {
        el.classList.remove("dragging");
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        state.updateSettings({ columnWidth: state.settings.columnWidth });
      }

      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    });
  }

  makeDraggable(leftResizer, true);
  makeDraggable(rightResizer, false);
}

/* ===== Typewriter Mode ===== */
let typewriterBoundary = null;

function setupTypewriterBoundary(view, state) {
  if (typewriterBoundary) return; // already set up

  typewriterBoundary = document.createElement("div");
  typewriterBoundary.className = "typewriter-boundary visible";
  document.body.appendChild(typewriterBoundary);
  typewriterBoundary.style.top = state.typewriterPosition * window.innerHeight + "px";

  applyTypewriterPadding(view, state);

  // Drag to reposition
  typewriterBoundary.addEventListener("mousedown", (e) => {
    e.preventDefault();
    typewriterBoundary.classList.add("dragging");

    function onMove(e2) {
      const newY = Math.max(50, Math.min(window.innerHeight - 50, e2.clientY));
      typewriterBoundary.style.top = newY + "px";
      state.typewriterPosition = newY / window.innerHeight;
      applyTypewriterPadding(view, state);
      scrollCursorToTypewriterLine(view, state);
    }

    function onUp() {
      typewriterBoundary.classList.remove("dragging");
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    }

    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });

  // Initial scroll
  requestAnimationFrame(() => scrollCursorToTypewriterLine(view, state));
}

function applyTypewriterPadding(view, state) {
  const targetY = state.typewriterPosition * window.innerHeight;
  // Top padding so the first line can be scrolled down to the boundary
  view.scrollDOM.style.paddingTop = targetY + "px";
  // Bottom padding so the last line can scroll up to the boundary
  view.scrollDOM.style.paddingBottom = (window.innerHeight - targetY) + "px";
}

function removeTypewriterBoundary(view, state) {
  if (typewriterBoundary) {
    typewriterBoundary.remove();
    typewriterBoundary = null;
  }
  // Don't clear padding if ratchet mode is using it
  if (view && !(state && state.ratchetMode)) {
    view.scrollDOM.style.paddingTop = "";
    view.scrollDOM.style.paddingBottom = "";
  }
}

function scrollCursorToTypewriterLine(view, state) {
  if (!state.typewriterMode && !state.ratchetMode) return;
  const head = view.state.selection.main.head;
  const coords = view.coordsAtPos(head);
  if (!coords) return;
  // Ratchet uses center (0.5), typewriter uses user-configured position
  const position = state.ratchetMode ? 0.5 : state.typewriterPosition;
  const targetY = position * window.innerHeight;
  // Align the bottom of the current line with the typewriter boundary
  const offset = coords.bottom - targetY;
  if (Math.abs(offset) > 1) {
    view.scrollDOM.scrollTop += offset;
  }
}

/* ===== Ratchet Typewriter Padding ===== */
function applyRatchetTypewriterPadding(view) {
  const targetY = 0.5 * window.innerHeight;
  view.scrollDOM.style.paddingTop = targetY + "px";
  view.scrollDOM.style.paddingBottom = (window.innerHeight - targetY) + "px";
}

/* ===== Ratchet Timer ===== */
function updateRatchetTimer(state) {
  let timerEl = document.querySelector(".ratchet-timer");

  if (!state.ratchetMode) {
    if (timerEl) timerEl.remove();
    return;
  }

  if (!timerEl) {
    timerEl = document.createElement("div");
    timerEl.className = "ratchet-timer";
    document.body.appendChild(timerEl);
  }

  function tick() {
    if (!state.ratchetMode || !state.ratchetEndTime) {
      timerEl.remove();
      return;
    }
    const remaining = Math.max(0, state.ratchetEndTime - Date.now());
    if (remaining <= 0) {
      state.stopRatchet();
      timerEl.remove();
      return;
    }
    const mins = Math.floor(remaining / 60000);
    const secs = Math.floor((remaining % 60000) / 1000);
    timerEl.textContent = `${mins}:${secs.toString().padStart(2, "0")}`;
    requestAnimationFrame(tick);
  }

  tick();
}
