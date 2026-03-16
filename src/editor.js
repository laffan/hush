import { EditorView, keymap, drawSelection, placeholder } from "@codemirror/view";
import { EditorState, Prec } from "@codemirror/state";
import { markdown } from "@codemirror/lang-markdown";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";

/**
 * Creates the CodeMirror 6 editor instance.
 */
export function createEditor(container, state) {
  const updateListener = EditorView.updateListener.of((update) => {
    if (update.docChanged) {
      state.markDirty();
    }
  });

  // Minimal theme
  const hushTheme = EditorView.theme({
    "&": {
      height: "100%",
      background: "transparent",
    },
    ".cm-scroller": {
      fontFamily: "var(--font-family)",
      fontSize: "var(--font-size)",
      lineHeight: "1.6",
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
    ".cm-activeLine": {
      backgroundColor: "transparent",
    },
    ".cm-selectionBackground": {
      backgroundColor: "rgba(128, 128, 128, 0.3)",
    },
    "&.cm-focused .cm-selectionBackground": {
      backgroundColor: "rgba(128, 128, 128, 0.3)",
    },
    ".cm-gutters": {
      display: "none",
    },
  });

  // Ratchet mode: block backspace/delete/selection/arrow-left
  const ratchetKeymap = Prec.highest(
    keymap.of([
      {
        key: "Backspace",
        run: () => state.ratchetMode,
      },
      {
        key: "Delete",
        run: () => state.ratchetMode,
      },
      {
        key: "ArrowLeft",
        run: () => state.ratchetMode,
      },
      {
        key: "ArrowUp",
        run: () => state.ratchetMode,
      },
      {
        key: "Home",
        run: () => state.ratchetMode,
      },
      {
        key: "Mod-a",
        run: () => state.ratchetMode,
      },
      {
        key: "Mod-z",
        run: () => state.ratchetMode,
      },
      {
        key: "Mod-x",
        run: () => state.ratchetMode,
      },
    ])
  );

  // Block mouse selection in ratchet mode
  const ratchetMouseFilter = EditorView.domEventHandlers({
    mousedown: (_event, _view) => {
      if (state.ratchetMode) return true;
      return false;
    },
  });

  const startState = EditorState.create({
    doc: "",
    extensions: [
      hushTheme,
      markdown(),
      history(),
      drawSelection(),
      closeBrackets(),
      updateListener,
      ratchetKeymap,
      ratchetMouseFilter,
      keymap.of([...defaultKeymap, ...historyKeymap, ...closeBracketsKeymap]),
      placeholder("Start writing..."),
      EditorView.lineWrapping,
    ],
  });

  const view = new EditorView({
    state: startState,
    parent: container,
  });

  // Typewriter scroll effect
  state.on("mode-changed", () => {
    applyModes(state);
    if (state.typewriterMode) {
      setupTypewriterScroll(view, state);
    }
  });

  // Private mode decoration
  state.on("mode-changed", () => {
    updatePrivateMode(view, state);
  });

  // Ratchet timer display
  state.on("mode-changed", () => {
    updateRatchetTimer(state);
  });

  // Fullscreen
  state.on("fullscreen-changed", () => {
    applyFullscreen(state);
  });

  return {
    view,
    getContent: () => view.state.doc.toString(),
    setContent: (text) => {
      view.dispatch({
        changes: {
          from: 0,
          to: view.state.doc.length,
          insert: text,
        },
      });
    },
    focus: () => view.focus(),
  };
}

function applyModes(state) {
  const app = document.getElementById("app");

  app.classList.toggle("ratchet-active", state.ratchetMode);
  app.classList.toggle("private-mode", state.privateMode);
  app.classList.toggle("typewriter-mode", state.typewriterMode);
}

function applyFullscreen(state) {
  const app = document.getElementById("app");
  app.classList.toggle("fullscreen-mode", state.isFullscreen);

  const IS_TAURI = typeof window !== "undefined" && window.__TAURI_INTERNALS__;
  if (IS_TAURI) {
    import("@tauri-apps/api/core").then(({ invoke }) => {
      invoke("toggle_fullscreen").catch(console.error);
    });
  }

  // Column resizers for fullscreen
  updateColumnResizers(state);
}

function updateColumnResizers(state) {
  // Remove existing
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

  // Drag to resize
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

function updatePrivateMode(view, state) {
  if (state.privateMode) {
    // Apply private mode via CSS class on lines
    // We'll use a ViewPlugin approach via CSS
    // The CSS .private-mode already hides text color
    // But we need per-character boxes for non-space chars
    applyPrivateDecorations(view);
  } else {
    removePrivateDecorations(view);
  }
}

function applyPrivateDecorations(view) {
  // Use MutationObserver to apply spans when content changes
  const container = view.dom;

  function decorateLines() {
    if (!document.getElementById("app").classList.contains("private-mode")) return;

    container.querySelectorAll(".cm-line").forEach((line) => {
      if (line.dataset.privatized) return;
      const text = line.textContent;
      if (!text.trim()) return;

      // Build new content preserving word shapes
      const frag = document.createDocumentFragment();
      for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        const span = document.createElement("span");
        span.textContent = ch;
        if (ch !== " " && ch !== "\t" && ch !== "\n") {
          span.className = "private-char";
        }
        frag.appendChild(span);
      }

      // Don't modify CM's internal DOM — let CSS handle it
      // Instead just ensure the class is applied
    });
  }

  // Let CSS handle the visual hiding. The .private-mode class
  // makes text transparent and we add background to chars via CSS.
  // This is simpler and doesn't break CodeMirror's DOM.
}

function removePrivateDecorations(_view) {
  // CSS class removal handles it
}

function setupTypewriterScroll(view, state) {
  if (!state.typewriterMode) return;

  // Show draggable boundary
  let boundary = document.querySelector(".typewriter-boundary");
  if (!boundary) {
    boundary = document.createElement("div");
    boundary.className = "typewriter-boundary visible";
    document.body.appendChild(boundary);
  }
  boundary.classList.add("visible");
  boundary.style.top = state.typewriterPosition * window.innerHeight + "px";

  // Drag
  let startY;
  boundary.addEventListener("mousedown", (e) => {
    e.preventDefault();
    startY = e.clientY;
    boundary.classList.add("dragging");

    function onMove(e2) {
      const newY = Math.max(100, Math.min(window.innerHeight - 100, e2.clientY));
      boundary.style.top = newY + "px";
      state.typewriterPosition = newY / window.innerHeight;
    }

    function onUp() {
      boundary.classList.remove("dragging");
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    }

    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });

  // Typewriter: keep cursor at the boundary position
  const scrollToCursor = () => {
    if (!state.typewriterMode) return;
    const cursor = view.dom.querySelector(".cm-cursor");
    if (cursor) {
      const cursorRect = cursor.getBoundingClientRect();
      const targetY = state.typewriterPosition * window.innerHeight;
      const scroller = view.scrollDOM;
      const offset = cursorRect.top - targetY;
      scroller.scrollTop += offset;
    }
  };

  // Scroll on every update
  const interval = setInterval(() => {
    if (!state.typewriterMode) {
      clearInterval(interval);
      boundary.classList.remove("visible");
      return;
    }
    scrollToCursor();
  }, 100);
}

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
