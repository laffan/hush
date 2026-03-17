import { EditorView, keymap, drawSelection, placeholder } from "@codemirror/view";
import { EditorState, Prec, Compartment } from "@codemirror/state";
import { markdown } from "@codemirror/lang-markdown";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags } from "@lezer/highlight";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { getActiveTheme } from "./themes.js";
import { createPrivateModePlugin } from "./private-mode.js";

const themeCompartment = new Compartment();

// Markdown inline rendering styles — makes headings larger, bold bold, italic italic, etc.
const markdownHighlight = HighlightStyle.define([
  { tag: tags.heading1, fontSize: "1.8em", fontWeight: "700", lineHeight: "1.3" },
  { tag: tags.heading2, fontSize: "1.5em", fontWeight: "700", lineHeight: "1.3" },
  { tag: tags.heading3, fontSize: "1.3em", fontWeight: "600", lineHeight: "1.3" },
  { tag: tags.heading4, fontSize: "1.15em", fontWeight: "600" },
  { tag: tags.heading5, fontSize: "1.05em", fontWeight: "600" },
  { tag: tags.heading6, fontSize: "1em", fontWeight: "600" },
  { tag: tags.strong, fontWeight: "bold" },
  { tag: tags.emphasis, fontStyle: "italic" },
  { tag: tags.strikethrough, textDecoration: "line-through" },
  { tag: tags.link, textDecoration: "underline" },
  { tag: tags.url, textDecoration: "underline", opacity: "0.7" },
  { tag: tags.monospace, fontFamily: "'Fira Code', 'Consolas', monospace", fontSize: "0.9em" },
  // Dim the markdown syntax characters (# * _ ` etc.)
  { tag: tags.processingInstruction, opacity: "0.4" },
]);

/**
 * Creates the CodeMirror 6 editor instance.
 */
export function createEditor(container, state) {
  const updateListener = EditorView.updateListener.of((update) => {
    if (update.docChanged) {
      state.markDirty();
    }
    // Typewriter: scroll cursor to fixed position on every update
    if (state.typewriterMode && (update.docChanged || update.selectionSet)) {
      requestAnimationFrame(() => scrollCursorToTypewriterLine(update.view, state));
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

  // Ratchet mode: block backspace/delete/selection/arrow-left
  const ratchetKeymap = Prec.highest(
    keymap.of([
      { key: "Backspace", run: () => state.ratchetMode },
      { key: "Delete", run: () => state.ratchetMode },
      { key: "ArrowLeft", run: () => state.ratchetMode },
      { key: "ArrowUp", run: () => state.ratchetMode },
      { key: "Home", run: () => state.ratchetMode },
      { key: "Mod-a", run: () => state.ratchetMode },
      { key: "Mod-z", run: () => state.ratchetMode },
      { key: "Mod-x", run: () => state.ratchetMode },
    ])
  );

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
      syntaxHighlighting(markdownHighlight),
      markdown(),
      history(),
      drawSelection(),
      closeBrackets(),
      updateListener,
      ratchetKeymap,
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
    // When ratchet mode starts, move cursor to end of document
    if (state.ratchetMode) {
      const end = view.state.doc.length;
      view.dispatch({ selection: { anchor: end } });
      view.focus();
    }
    if (state.typewriterMode) {
      setupTypewriterBoundary(view, state);
    } else {
      removeTypewriterBoundary(view);
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
  });

  return {
    view,
    getContent: () => view.state.doc.toString(),
    setContent: (text) => {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: text },
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

      // Switch back to Accessory when exiting fullscreen
      if (!state.isFullscreen) {
        await invoke("set_activation_policy", { policy: "accessory" });
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

function removeTypewriterBoundary(view) {
  if (typewriterBoundary) {
    typewriterBoundary.remove();
    typewriterBoundary = null;
  }
  if (view) {
    view.scrollDOM.style.paddingTop = "";
    view.scrollDOM.style.paddingBottom = "";
  }
}

function scrollCursorToTypewriterLine(view, state) {
  if (!state.typewriterMode) return;
  const head = view.state.selection.main.head;
  const coords = view.coordsAtPos(head);
  if (!coords) return;
  const targetY = state.typewriterPosition * window.innerHeight;
  // Align the bottom of the current line with the typewriter boundary
  const offset = coords.bottom - targetY;
  if (Math.abs(offset) > 1) {
    view.scrollDOM.scrollTop += offset;
  }
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
