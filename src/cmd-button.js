/**
 * iOS Cmd Button — a floating ⌘ pill in the bottom-left of the editor
 * that touch-only users can hold to mimic the Cmd key being pressed.
 *
 * The hardware Cmd modifier shows up on browser events as `e.metaKey`;
 * this module exposes `isCmdHeld(event)` so call sites can opt-in to
 * "real Cmd OR virtual Cmd" without each caller knowing about the
 * button. While the button is held:
 *   - `window.__hushCmdHeld` is true (read by `isCmdHeld`)
 *   - <body class="cmd-held"> is set so CSS hooks can react
 *   - synthetic Meta keydown/keyup events bracket the hold so any
 *     keydown listeners that key off `e.metaKey` alone can also pick
 *     it up.
 *
 * The button mirrors the sidebar-floating-toggle's geometry:
 * 20 px from the window's bottom-left when the panel is closed, and
 * 20 px from the panel's right edge while the files panel is open.
 */

/** Detect iOS / iPadOS — iPad reports as MacIntel since iPadOS 13, so
 *  the userAgent check alone misses it. Accept any platform that has
 *  multiple touch points OR the iPad-style platform shape. */
function isIOSDevice() {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent || "";
  if (/iPad|iPhone|iPod/.test(ua)) return true;
  // Modern iPad (Safari + Tauri WebView): platform == "MacIntel" but
  // navigator.maxTouchPoints > 0 (Macs report 0). Allow any positive
  // value rather than the stricter > 1 — some WebView versions only
  // expose 1.
  const platform = navigator.platform || "";
  const touchPoints = typeof navigator.maxTouchPoints === "number" ? navigator.maxTouchPoints : 0;
  if (/Mac/i.test(platform) && touchPoints > 0) return true;
  return false;
}

/** Single source of truth for "Cmd is held" — call sites use this in
 *  place of `e.metaKey || e.ctrlKey` when they want to honour the
 *  on-screen button. The window global lets non-module callers
 *  (legacy inline listeners) read the same flag. */
export function isCmdHeld(event) {
  if (event && (event.metaKey || event.ctrlKey)) return true;
  return !!(typeof window !== "undefined" && window.__hushCmdHeld);
}

let _btn = null;
let _state = null;
let _panelObserver = null;

export function initCmdButton(state) {
  _state = state;
  applyCmdButtonVisibility();
  state.on("settings-changed", applyCmdButtonVisibility);
}

function applyCmdButtonVisibility() {
  if (!_state) return;
  const wantVisible = !!(isIOSDevice() && _state.settings?.showCmdButton);
  if (wantVisible && !_btn) mountButton();
  else if (!wantVisible && _btn) unmountButton();
}

function mountButton() {
  if (_btn) return;
  const btn = document.createElement("button");
  btn.className = "cmd-floating-button";
  btn.setAttribute("aria-label", "Hold to press Cmd");
  btn.setAttribute("aria-pressed", "false");
  btn.title = "Hold to press Cmd";
  btn.textContent = "⌘"; // ⌘
  document.body.appendChild(btn);
  _btn = btn;

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
  // Lost focus / accessibility tap-out — release defensively.
  btn.addEventListener("lostpointercapture", release);
  // On the off chance a pointerdown lands but pointerup never fires
  // (e.g. user lifts finger off-button before browser fires up event,
  // somehow), watching for visibility change clears stale holds.
  document.addEventListener("visibilitychange", () => {
    if (document.hidden && activePointerId !== null) {
      activePointerId = null;
      setHeld(false);
      btn.classList.remove("active");
      btn.setAttribute("aria-pressed", "false");
    }
  });

  // Watch panel-overlay class to track open/close so the button rides
  // the panel's right edge — same idiom as the sidebar-floating-toggle.
  syncPanelOpen();
  const panel = document.getElementById("panel-overlay");
  if (panel) {
    _panelObserver = new MutationObserver(syncPanelOpen);
    _panelObserver.observe(panel, { attributes: true, attributeFilter: ["class"] });
  }
}

function unmountButton() {
  if (_btn) {
    setHeld(false);
    _btn.remove();
    _btn = null;
  }
  if (_panelObserver) {
    _panelObserver.disconnect();
    _panelObserver = null;
  }
}

function syncPanelOpen() {
  if (!_btn) return;
  const panel = document.getElementById("panel-overlay");
  const isOpen = !!(panel && !panel.classList.contains("hidden"));
  _btn.classList.toggle("panel-open", isOpen);
}

function setHeld(held) {
  if (typeof window === "undefined") return;
  const prev = !!window.__hushCmdHeld;
  window.__hushCmdHeld = !!held;
  if (held === prev) return;
  document.body.classList.toggle("cmd-held", !!held);
  // Bracket the hold with synthetic Meta keydown/keyup events so any
  // keyboard listeners that look at `e.metaKey` also see the modifier
  // as engaged. Use the window target — that's where the global
  // shortcut routers in main.js / window-shortcuts.js listen.
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
