/**
 * Native-`title` tooltip gating. The user's "Show Tooltips" setting flips
 * native browser tooltips on or off across the app — sidebar buttons,
 * pane header buttons, and notebook toolbar buttons all consult the same
 * setting.
 *
 * Implementation: every gated element stashes its label on `data-tooltip`.
 * When tooltips are enabled we mirror that to the `title` attribute (so
 * the browser shows the tooltip on hover); when disabled we strip it.
 *
 * **iPadOS renders no `title` tooltip at all** — the attribute is a
 * hover affordance and WebKit on iOS has no hover to hang it off, so
 * with the setting on the whole feature was simply missing there (and
 * silently: nothing errors, the attribute is set, nothing draws). A
 * touch device also gets one from a Magic Keyboard trackpad, which does
 * hover, so the fallback covers both: a delegated press-and-hold on any
 * `[data-tooltip]` element paints our own bubble, and a `mouse` pointer
 * hovering one does the same after a beat. Both are painted, not
 * native, so they are the only tooltips that surface under `html.ios`.
 * The hold never cancels the gesture underneath it — a button pressed
 * long enough to read its own label still fires.
 *
 * The sidebar uses its own custom-styled tooltip (see sidebar.js); it
 * gates on the same setting but doesn't go through this module — its
 * tooltips don't rely on the `title` attribute.
 *
 * Leaf module: no app imports (the lazily-loaded notebook bundle pulls
 * it in through `ui/dom-helpers.ts`), hence the local `isIOS` copy.
 */

let _enabled = false;

/** iOS / iPadOS, including an iPad reporting itself as a Mac. Local copy
 *  of `clipboard-image.js`'s `isIOS` — this module is a leaf on purpose.
 *  The painted layer is gated on it: where the native tooltip works, a
 *  second painted one on the same hover would just be a duplicate. */
function isIOS() {
  if (typeof navigator === "undefined") return false;
  if (/iPad|iPhone|iPod/.test(navigator.userAgent || "")) return true;
  const tp = typeof navigator.maxTouchPoints === "number" ? navigator.maxTouchPoints : 0;
  return /Mac/i.test(navigator.platform || "") && tp > 0;
}

/** Apply enable/disable globally. Walks the DOM once to add or strip
 *  `title` attributes on every element that previously called
 *  `applyTooltip`. */
export function setTooltipsEnabled(enabled) {
  _enabled = !!enabled;
  document.body.classList.toggle("tooltips-on", _enabled);
  if (_enabled) installPaintedTooltips();
  else hidePainted();
  refreshTooltips();
}

/** Re-walk every `[data-tooltip]` element and add/strip the `title`
 *  attribute to match the current enabled state. Call this after
 *  rendering new tooltip-bearing markup so freshly-added elements pick
 *  up the user's setting without a settings round-trip. */
export function refreshTooltips() {
  for (const el of document.querySelectorAll("[data-tooltip]")) {
    if (_enabled) el.title = el.dataset.tooltip;
    else el.removeAttribute("title");
  }
}

/** Mark `el` as tooltip-bearing with `label`. Stashes the label on
 *  `data-tooltip` so future toggles can find it; sets the live `title`
 *  attribute only when tooltips are currently enabled. Pass `null`/empty
 *  to clear. */
export function applyTooltip(el, label) {
  if (!el) return;
  if (!label) {
    delete el.dataset.tooltip;
    el.removeAttribute("title");
    return;
  }
  el.dataset.tooltip = label;
  if (_enabled) el.title = label;
  else el.removeAttribute("title");
}

export function tooltipsEnabled() { return _enabled; }

/* ===== Painted tooltips (touch + trackpad hover) ===== */

// Long enough that an ordinary tap on a button never trips it, short
// enough that "hold to find out what this does" feels like an answer.
const HOLD_MS = 450;
const HOVER_MS = 500;
// A press that travels is a drag (the mini-palette's size readout, a
// toolbar being dragged to a new edge) — never a request for a label.
const MOVE_SLOP_PX = 10;
// The finger is still covering the control, so the bubble has to outlive
// the release for the label to be readable at all.
const LINGER_MS = 1600;
const EDGE_PAD = 6;
const GAP_PX = 8;

let _installed = false;
let _bubble = null;
let _holdTimer = 0;
let _hideTimer = 0;
let _pressAnchor = null;
let _pressStart = null;
let _pressPointerId = null;

function installPaintedTooltips() {
  if (_installed || !isIOS()) return;
  _installed = true;
  // Capture phase throughout: chrome that floats over the canvas stops
  // `pointerdown` propagation at the target (the mini-palette strip, the
  // brush flyout), and a bubbling listener would never hear those.
  document.addEventListener("pointerdown", onPointerDown, true);
  document.addEventListener("pointermove", onPointerMove, true);
  document.addEventListener("pointerup", onPointerEnd, true);
  document.addEventListener("pointercancel", onPointerEnd, true);
  document.addEventListener("pointerover", onPointerOver, true);
  document.addEventListener("pointerout", onPointerOut, true);
  // A tooltip pinned to an element that has scrolled away is worse than
  // none; the same goes for one whose anchor a re-render has replaced.
  window.addEventListener("scroll", hidePainted, true);
  window.addEventListener("blur", hidePainted);
}

function labelledAncestor(node) {
  let el = node instanceof Element ? node : null;
  while (el && el !== document.body) {
    if (el.dataset && el.dataset.tooltip) return el;
    el = el.parentElement;
  }
  return null;
}

function onPointerDown(e) {
  cancelHold();
  hidePainted();
  if (!_enabled) return;
  // A mouse press is a click, not a request for a label — the hover
  // route already covers a pointer that lingers.
  if (e.pointerType === "mouse") return;
  const el = labelledAncestor(e.target);
  if (!el) return;
  _pressAnchor = el;
  _pressStart = { x: e.clientX, y: e.clientY };
  _pressPointerId = e.pointerId;
  _holdTimer = window.setTimeout(() => {
    _holdTimer = 0;
    if (_pressAnchor && _pressAnchor.isConnected) showPainted(_pressAnchor);
  }, HOLD_MS);
}

function onPointerMove(e) {
  if (!_pressStart || e.pointerId !== _pressPointerId) return;
  const dx = e.clientX - _pressStart.x;
  const dy = e.clientY - _pressStart.y;
  if (dx * dx + dy * dy > MOVE_SLOP_PX * MOVE_SLOP_PX) {
    cancelHold();
    hidePainted();
  }
}

function onPointerEnd(e) {
  if (_pressPointerId !== null && e.pointerId !== _pressPointerId) return;
  const showing = !!_bubble && _bubble.classList.contains("visible");
  cancelHold();
  // Don't tear it down on the release that produced it — the finger was
  // over the control the whole time it was up.
  if (showing) scheduleHide(LINGER_MS);
}

/** Trackpad / mouse hover on iPad — the one pointer there that has a
 *  hover state, and still no native tooltip to show for it. */
function onPointerOver(e) {
  if (!_enabled || e.pointerType !== "mouse") return;
  const el = labelledAncestor(e.target);
  if (!el || el === _pressAnchor) return;
  cancelHold();
  _pressAnchor = el;
  _pressPointerId = null;
  _pressStart = null;
  _holdTimer = window.setTimeout(() => {
    _holdTimer = 0;
    if (_pressAnchor && _pressAnchor.isConnected) showPainted(_pressAnchor);
  }, HOVER_MS);
}

function onPointerOut(e) {
  if (e.pointerType !== "mouse") return;
  if (!_pressAnchor) return;
  const to = e.relatedTarget;
  if (to instanceof Node && _pressAnchor.contains(to)) return;
  cancelHold();
  hidePainted();
}

function cancelHold() {
  if (_holdTimer) { clearTimeout(_holdTimer); _holdTimer = 0; }
  _pressAnchor = null;
  _pressStart = null;
  _pressPointerId = null;
}

function scheduleHide(ms) {
  if (_hideTimer) clearTimeout(_hideTimer);
  _hideTimer = window.setTimeout(() => { _hideTimer = 0; hidePainted(); }, ms);
}

function hidePainted() {
  if (_hideTimer) { clearTimeout(_hideTimer); _hideTimer = 0; }
  if (_bubble) _bubble.classList.remove("visible");
}

function showPainted(anchor) {
  const label = anchor.dataset && anchor.dataset.tooltip;
  if (!label) return;
  const rect = anchor.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return;
  if (!_bubble) {
    _bubble = document.createElement("div");
    _bubble.className = "hush-painted-tooltip";
    document.body.appendChild(_bubble);
  }
  _bubble.textContent = label;
  // Measure off-screen at the final width before committing a position —
  // the bubble is `white-space: nowrap`, so its box is only known once
  // the text is in it.
  _bubble.style.left = "0px";
  _bubble.style.top = "-9999px";
  _bubble.classList.add("visible");
  const bw = _bubble.offsetWidth;
  const bh = _bubble.offsetHeight;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  // The iPad reserves a band at the top of the window that
  // `env(safe-area-inset-*)` doesn't report (see README-TECHNICAL) —
  // clamping to 6 px there would tuck the bubble under the system menu.
  const topPad = document.documentElement.classList.contains("ios") ? 34 : EDGE_PAD;
  let left = rect.left + rect.width / 2 - bw / 2;
  left = Math.max(EDGE_PAD, Math.min(left, vw - bw - EDGE_PAD));
  let top = rect.top - bh - GAP_PX;
  if (top < topPad) top = Math.min(rect.bottom + GAP_PX, vh - bh - EDGE_PAD);
  _bubble.style.left = `${Math.round(left)}px`;
  _bubble.style.top = `${Math.round(top)}px`;
  scheduleHide(LINGER_MS + HOLD_MS);
}
