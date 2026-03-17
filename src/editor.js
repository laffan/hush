import { EditorView, keymap, drawSelection, placeholder } from "@codemirror/view";
import { EditorState, Prec, Compartment } from "@codemirror/state";
import { markdown } from "@codemirror/lang-markdown";
import { defaultHighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { getActiveTheme } from "./themes.js";
import { createPrivateModePlugin } from "./private-mode.js";

const themeCompartment = new Compartment();

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
      syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
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
    if (state.typewriterMode) {
      setupTypewriterBoundary(view, state);
    } else {
      removeTypewriterBoundary();
    }
  });

  // Fullscreen
  state.on("fullscreen-changed", () => {
    applyFullscreen(state);
  });

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
      const win = getCurrentWindow();
      // Use setSimpleFullscreen on macOS for better behavior (no new space),
      // fall back to setFullscreen on other platforms
      try {
        await win.setSimpleFullscreen(state.isFullscreen);
      } catch (_) {
        await win.setFullscreen(state.isFullscreen);
      }
    } catch (e) {
      console.error("Fullscreen toggle failed:", e);
    }
  }

  updateColumnResizers(state);
}

function updateColumnResizers(state) {
  document.querySelectorAll(".column-resizer").forEach((el) => el.remove());
  if (!state.isFullscreen) return;

  const leftResizer = document.createElement("div");
  leftResizer.className = "column-resizer left";
  const rightResizer = document.createElement("div");
  rightResizer.className = "column-resizer right";

  document.body.appendChild(leftResizer);
  document.body.appendChild(rightResizer);

  function positionResizers() {
    const w = window.innerWidth;
    const colW = state.settings.columnWidth;
    const left = (w - colW) / 2;
    leftResizer.style.left = left + "px";
    rightResizer.style.left = left + colW + "px";
    document.documentElement.style.setProperty("--column-width", colW + "px");
  }

  positionResizers();

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
        positionResizers();
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

  // Drag to reposition
  typewriterBoundary.addEventListener("mousedown", (e) => {
    e.preventDefault();
    typewriterBoundary.classList.add("dragging");

    function onMove(e2) {
      const newY = Math.max(50, Math.min(window.innerHeight - 50, e2.clientY));
      typewriterBoundary.style.top = newY + "px";
      state.typewriterPosition = newY / window.innerHeight;
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

function removeTypewriterBoundary() {
  if (typewriterBoundary) {
    typewriterBoundary.remove();
    typewriterBoundary = null;
  }
}

function scrollCursorToTypewriterLine(view, state) {
  if (!state.typewriterMode) return;
  const head = view.state.selection.main.head;
  const coords = view.coordsAtPos(head);
  if (!coords) return;
  const targetY = state.typewriterPosition * window.innerHeight;
  const offset = coords.top - targetY;
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
