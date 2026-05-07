/**
 * Touch-mode floating buttons (iOS / iPadOS only).
 *
 * Three pills in the bottom-left of the editor for keyboard-free use:
 *   - ⌘ button: hold to mimic the Cmd key being pressed (drag text
 *     out of a pane, Cmd-drag to merge flowchart nodes, Cmd-click on
 *     a link, etc.).
 *   - ☰ button: tap to open the command palette.
 *   - 📋 button: tap to paste the system clipboard into whatever
 *     surface is currently in focus (doc editor, notebook canvas,
 *     inline text shape, focused input/textarea/contenteditable).
 *
 * The Cmd modifier shows up on browser events as `e.metaKey`; this
 * module exposes `isCmdHeld(event)` so call sites can opt-in to "real
 * Cmd OR virtual Cmd" without each caller knowing about the button.
 * While the button is held:
 *   - `window.__hushCmdHeld` is true (read by `isCmdHeld`)
 *   - <body class="cmd-held"> is set
 *   - synthetic Meta keydown/keyup events bracket the hold so any
 *     keydown listeners that key off `e.metaKey` alone also pick up
 *     the modifier.
 *
 * Both buttons mirror the sidebar-floating-toggle's geometry: 20 px
 * from the window's bottom-left when the panel is closed, and 20 px
 * from the panel's right edge when it's open. They stack vertically
 * (Cmd button on the bottom, palette button above).
 */

/** Detect iOS / iPadOS — iPad reports as MacIntel since iPadOS 13, so
 *  the userAgent check alone misses it. */
function isIOSDevice() {
  if (typeof navigator === "undefined") return false;
  if (/iPad|iPhone|iPod/.test(navigator.userAgent || "")) return true;
  // Modern iPad (Safari + Tauri WebView): platform == "MacIntel" but
  // navigator.maxTouchPoints > 0 (real Macs report 0). Allow any
  // positive value — some WebView versions only expose 1.
  const tp = typeof navigator.maxTouchPoints === "number" ? navigator.maxTouchPoints : 0;
  return /Mac/i.test(navigator.platform || "") && tp > 0;
}

/** Single source of truth for "Cmd is held". Call sites use this in
 *  place of `e.metaKey || e.ctrlKey` when they want to honour the
 *  on-screen button. The `window.__hushCmdHeld` global lets non-module
 *  callers (drag-drop.js, notebook input-handler.ts) read the same
 *  flag without an import. */
export function isCmdHeld(event) {
  if (event && (event.metaKey || event.ctrlKey)) return true;
  return !!(typeof window !== "undefined" && window.__hushCmdHeld);
}

let _cmdBtn = null;
let _paletteBtn = null;
let _pasteBtn = null;
let _undoBtn = null;
let _state = null;
let _panelObserver = null;

export function initCmdButton(state) {
  _state = state;
  applyButtonVisibility();
  state.on("settings-changed", applyButtonVisibility);
}

function applyButtonVisibility() {
  if (!_state) return;
  // The setting flag stayed `showCmdButton` for one release before being
  // renamed to `touchMode`; honour both so a previously-saved settings
  // file doesn't silently lose the toggle on upgrade.
  const enabled = !!(isIOSDevice()
    && (_state.settings?.touchMode || _state.settings?.showCmdButton));
  if (enabled && !_cmdBtn) mountButtons();
  else if (!enabled && _cmdBtn) unmountButtons();
}

function mountButtons() {
  if (_cmdBtn) return;

  // ⌘ button — hold to engage Cmd
  _cmdBtn = document.createElement("button");
  _cmdBtn.className = "cmd-floating-button";
  _cmdBtn.setAttribute("aria-label", "Hold to press Cmd");
  _cmdBtn.setAttribute("aria-pressed", "false");
  _cmdBtn.title = "Hold to press Cmd";
  _cmdBtn.textContent = "⌘";
  document.body.appendChild(_cmdBtn);
  wireCmdHold(_cmdBtn);

  // ☰ button — tap to open command palette
  _paletteBtn = document.createElement("button");
  _paletteBtn.className = "cmd-floating-button cmd-palette-button";
  _paletteBtn.setAttribute("aria-label", "Open command palette");
  _paletteBtn.title = "Open command palette";
  _paletteBtn.innerHTML = `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="6" x2="20" y2="6"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="18" x2="20" y2="18"/></svg>`;
  document.body.appendChild(_paletteBtn);
  _paletteBtn.addEventListener("click", () => {
    import("./command-palette.js").then((m) => m.toggleCommandPalette?.(_state)).catch(() => {});
  });

  // 📋 button — tap to paste the OS clipboard into the active surface.
  // Sits above the palette button. iPadOS users without a hardware
  // keyboard need this since synthetic Cmd+V from a virtual keyboard
  // doesn't reach CodeMirror's paste path.
  _pasteBtn = document.createElement("button");
  _pasteBtn.className = "cmd-floating-button cmd-paste-button";
  _pasteBtn.setAttribute("aria-label", "Paste from clipboard");
  _pasteBtn.title = "Paste from clipboard";
  _pasteBtn.innerHTML = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="4" width="12" height="16" rx="2"/><path d="M9 4h6v3H9z" fill="currentColor" stroke="none"/><line x1="9" y1="11" x2="15" y2="11"/><line x1="9" y1="14" x2="15" y2="14"/><line x1="9" y1="17" x2="13" y2="17"/></svg>`;
  document.body.appendChild(_pasteBtn);
  _pasteBtn.addEventListener("click", (e) => {
    e.preventDefault();
    import("./paste-helper.js").then((m) => m.pasteAtFocus?.()).catch(() => {});
  });

  // ↶ button — undo. Sits above the paste pill (fourth from the
  // bottom). Notebook context calls state.undo() directly via the
  // exported `notebookUndo`; doc context falls back to a synthetic
  // Cmd+Z keydown on the focused element so CodeMirror's history
  // keymap picks it up.
  _undoBtn = document.createElement("button");
  _undoBtn.className = "cmd-floating-button cmd-undo-button";
  _undoBtn.setAttribute("aria-label", "Undo");
  _undoBtn.title = "Undo";
  _undoBtn.innerHTML = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 14L4 9L9 4"/><path d="M4 9H14a6 6 0 0 1 0 12H10"/></svg>`;
  document.body.appendChild(_undoBtn);
  _undoBtn.addEventListener("click", (e) => {
    e.preventDefault();
    import("./notebook/notes-canvas").then((m) => {
      if (m.notebookUndo?.()) return;
      const target = document.activeElement || document.body;
      target.dispatchEvent(new KeyboardEvent("keydown", {
        key: "z", code: "KeyZ", keyCode: 90, metaKey: true, ctrlKey: true,
        bubbles: true, cancelable: true,
      }));
    }).catch(() => {});
  });

  syncPanelOpen();
  const panel = document.getElementById("panel-overlay");
  if (panel) {
    _panelObserver = new MutationObserver(syncPanelOpen);
    _panelObserver.observe(panel, { attributes: true, attributeFilter: ["class"] });
  }
}

function wireCmdHold(btn) {
  let activePointerId = null;
  function press(e) {
    if (activePointerId !== null) return;
    activePointerId = e.pointerId ?? "mouse";
    e.preventDefault();
    setHeld(true);
    btn.classList.add("active");
    btn.setAttribute("aria-pressed", "true");
    try { btn.setPointerCapture?.(e.pointerId); } catch (_) {}
  }
  function release(e) {
    if (activePointerId === null) return;
    if (e && e.pointerId !== undefined && e.pointerId !== activePointerId) return;
    activePointerId = null;
    setHeld(false);
    btn.classList.remove("active");
    btn.setAttribute("aria-pressed", "false");
    try { btn.releasePointerCapture?.(e.pointerId); } catch (_) {}
  }
  btn.addEventListener("pointerdown", press);
  btn.addEventListener("pointerup", release);
  btn.addEventListener("pointercancel", release);
  btn.addEventListener("lostpointercapture", release);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden && activePointerId !== null) {
      activePointerId = null;
      setHeld(false);
      btn.classList.remove("active");
      btn.setAttribute("aria-pressed", "false");
    }
  });
}

function unmountButtons() {
  setHeld(false);
  if (_cmdBtn) { _cmdBtn.remove(); _cmdBtn = null; }
  if (_paletteBtn) { _paletteBtn.remove(); _paletteBtn = null; }
  if (_pasteBtn) { _pasteBtn.remove(); _pasteBtn = null; }
  if (_undoBtn) { _undoBtn.remove(); _undoBtn = null; }
  if (_panelObserver) { _panelObserver.disconnect(); _panelObserver = null; }
}

function syncPanelOpen() {
  const panel = document.getElementById("panel-overlay");
  const isOpen = !!(panel && !panel.classList.contains("hidden"));
  if (_cmdBtn) _cmdBtn.classList.toggle("panel-open", isOpen);
  if (_paletteBtn) _paletteBtn.classList.toggle("panel-open", isOpen);
  if (_pasteBtn) _pasteBtn.classList.toggle("panel-open", isOpen);
  if (_undoBtn) _undoBtn.classList.toggle("panel-open", isOpen);
}

function setHeld(held) {
  if (typeof window === "undefined") return;
  const prev = !!window.__hushCmdHeld;
  window.__hushCmdHeld = !!held;
  if (held === prev) return;
  document.body.classList.toggle("cmd-held", !!held);
  // Bracket the hold with synthetic Meta keydown / keyup events so any
  // keyboard listeners that look at `e.metaKey` also see the modifier
  // as engaged.
  try {
    const Type = held ? "keydown" : "keyup";
    const ev = new KeyboardEvent(Type, {
      key: "Meta",
      code: "MetaLeft",
      bubbles: true,
      cancelable: true,
      metaKey: held,
    });
    window.dispatchEvent(ev);
  } catch (_) { /* old WebKit — synthetic event constructor missing */ }
}
