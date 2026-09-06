/**
 * Shared canvas surface for the desktop / drone file views.
 *
 * Owns everything neither view should re-solve: a device-pixel-ratio
 * backing store that follows the panel's width, a pan / zoom camera,
 * one pointer pipeline that yields taps, double-taps, drags, hover and
 * pinch on both a trackpad and a Pencil-free iPad, and a draw pass that
 * only runs when something asked for one.
 *
 * Colours are read off `<html>`'s custom properties rather than
 * re-resolved: `theme-colors.js#resolveEffectiveColors` is the single
 * chain that decides what `--fg` / `--theme-bg` are, and the sidebar
 * desync bug this repo already paid for came from hand-copying it. The
 * surface repaints on `theme-changed` / `style-changed`.
 */

const DOUBLE_TAP_MS = 320;
const TAP_SLOP = 6;      // px of travel a press may have and still be a tap
const DRAG_SLOP = 4;     // px before a press becomes a drag
const MIN_ZOOM = 0.35;
const MAX_ZOOM = 3;

/** Normalise any CSS colour to `{ r, g, b }` through a 1×1 context —
 *  the cheapest parser that understands hex, rgb(), rgba() and names. */
let _probe = null;
function parseColor(css, fallback) {
  if (!css) return fallback;
  if (!_probe) _probe = document.createElement("canvas").getContext("2d");
  _probe.fillStyle = "#000";
  try { _probe.fillStyle = css.trim(); } catch { return fallback; }
  const v = _probe.fillStyle;
  if (v.startsWith("#")) {
    const h = v.length === 4
      ? v.slice(1).split("").map((c) => c + c).join("")
      : v.slice(1);
    return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) };
  }
  const m = v.match(/rgba?\(([^)]+)\)/);
  if (!m) return fallback;
  const p = m[1].split(",").map((n) => parseFloat(n));
  return { r: p[0] | 0, g: p[1] | 0, b: p[2] | 0 };
}

/** Any CSS colour → `{ r, g, b }`, or `fallback` when it won't parse. */
export const toRgb = (css, fallback = null) => parseColor(css, fallback);

export const rgba = (c, a) => `rgba(${c.r}, ${c.g}, ${c.b}, ${a})`;
export const mix = (a, b, t) => ({
  r: Math.round(a.r + (b.r - a.r) * t),
  g: Math.round(a.g + (b.g - a.g) * t),
  b: Math.round(a.b + (b.b - a.b) * t),
});
export const luminance = (c) => (0.299 * c.r + 0.587 * c.g + 0.114 * c.b) / 255;

/** Clamp one camera axis against the content span `[min, max]`, with
 *  `half` the viewport's half-size in world units at the current zoom.
 *
 *  Content smaller than the window stays wholly inside it; content
 *  larger than the window keeps the window wholly inside it. Either way
 *  a pan or a zoom can never leave the user looking at blank canvas
 *  with nothing to steer back by. */
export function clampAxis(centre, min, max, half, pad = 16) {
  const lo = min - pad, hi = max + pad;
  if (hi - lo <= 2 * half) return Math.max(hi - half, Math.min(lo + half, centre));
  return Math.max(lo + half, Math.min(hi - half, centre));
}

/** Canvas `font` shorthand in the app-chrome face. `ctx.font` does not
 *  resolve custom properties, so `--ui-font-family` is read off `<html>`
 *  and cached — the sidebar canvas has to match the rows it replaced. */
let _uiFace = null;
export function uiFont(size, weight = 400) {
  if (_uiFace === null) {
    _uiFace = getComputedStyle(document.documentElement)
      .getPropertyValue("--ui-font-family").trim()
      || 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
  }
  return `${weight} ${size}px ${_uiFace}`;
}

function readColors() {
  const cs = getComputedStyle(document.documentElement);
  const g = (name, fb) => parseColor(cs.getPropertyValue(name), fb);
  const bg = g("--theme-bg", g("--bg", { r: 26, g: 26, b: 26 }));
  const fg = g("--fg", { r: 224, g: 224, b: 224 });
  return {
    bg, fg,
    border: g("--panel-border", mix(bg, fg, 0.2)),
    accent: g("--accent", mix(bg, fg, 0.45)),
    link: g("--link", g("--cursor", fg)),
    dark: luminance(bg) < 0.5,
  };
}

/**
 * @param {HTMLElement} container  panel body to fill
 * @param {object} h  view handlers — every one optional:
 *   hitTest(world, screen) → handle|null      what is under the pointer
 *   idOf(handle) → string                     identity for double-tap matching
 *   onDraw(ctx, ui)                           paint one frame
 *   onTap(handle, world, { double })          press that didn't travel
 *   deferSingleTap(handle) → boolean          hold the single tap for the
 *                                             double-tap window first
 *   onHover(handle, world)                    pointer moved with no button
 *   canDrag(handle) → boolean                 press on this becomes a drag
 *   onDrag(handle, world, delta)              per-move while dragging
 *   onDragEnd(handle)                         drag finished
 *   onKey(event) → boolean                    handled → swallow
 */
export function createSurface(container, h = {}) {
  const host = document.createElement("div");
  host.className = "file-view-host";
  const canvas = document.createElement("canvas");
  canvas.className = "file-view-canvas";
  canvas.tabIndex = 0;
  const chrome = document.createElement("div");
  chrome.className = "file-view-chrome";
  host.append(canvas, chrome);
  container.appendChild(host);

  const ctx = canvas.getContext("2d");
  const camera = { x: 0, y: 0, zoom: 1 };
  let colors = readColors();
  let width = 0, height = 0, dpr = 1;
  let raf = 0, destroyed = false;

  const ui = {
    get width() { return width; },
    get height() { return height; },
    camera, colors,
  };

  const worldToScreen = (wx, wy) => ({
    x: (wx - camera.x) * camera.zoom + width / 2,
    y: (wy - camera.y) * camera.zoom + height / 2,
  });
  const screenToWorld = (sx, sy) => ({
    x: (sx - width / 2) / camera.zoom + camera.x,
    y: (sy - height / 2) / camera.zoom + camera.y,
  });

  function requestDraw() {
    if (raf || destroyed) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      if (destroyed || !width || !height) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);
      ui.colors = colors;
      if (h.onDraw) h.onDraw(ctx, ui);
    });
  }

  function resize() {
    const w = Math.max(1, Math.round(host.clientWidth));
    const ht = Math.max(1, Math.round(host.clientHeight));
    const d = Math.min(3, window.devicePixelRatio || 1);
    if (w === width && ht === height && d === dpr) return;
    width = w; height = ht; dpr = d;
    canvas.width = Math.round(w * d);
    canvas.height = Math.round(ht * d);
    canvas.style.width = w + "px";
    canvas.style.height = ht + "px";
    if (h.onResize) h.onResize(ui);
    requestDraw();
  }
  const ro = new ResizeObserver(resize);
  ro.observe(host);
  resize();

  // ===== pointer pipeline =====
  const pointers = new Map(); // pointerId → { x, y }
  let press = null;           // { id, handle, startX, startY, moved, dragging }
  let pinch = null;           // { dist, cx, cy }
  let lastTap = null;         // { t, x, y, id }
  let deferTimer = 0;

  const local = (e) => {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  /** Let the view pull the camera back onto its content. Called after
   *  every pan, zoom and pinch, so no gesture can strand the user on
   *  empty canvas with nothing to steer back by. */
  function settle() {
    if (h.clampCamera) h.clampCamera(camera, { width, height });
    // Whatever was under the pointer is under a different part of the
    // model now; the next move will say what.
    if (h.onCameraChange) h.onCameraChange();
  }

  function zoomAt(sx, sy, factor) {
    const before = screenToWorld(sx, sy);
    camera.zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, camera.zoom * factor));
    const after = screenToWorld(sx, sy);
    camera.x += before.x - after.x;
    camera.y += before.y - after.y;
    settle();
    requestDraw();
  }

  function beginPinch() {
    const [a, b] = [...pointers.values()];
    pinch = {
      dist: Math.hypot(a.x - b.x, a.y - b.y) || 1,
      cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2,
    };
    press = null;
  }

  function onPointerDown(e) {
    canvas.focus({ preventScroll: true });
    const p = local(e);
    pointers.set(e.pointerId, p);
    if (pointers.size === 2) { beginPinch(); return; }
    if (pointers.size > 2) return;
    canvas.setPointerCapture?.(e.pointerId);
    const world = screenToWorld(p.x, p.y);
    const handle = h.hitTest ? h.hitTest(world, p) : null;
    press = { id: e.pointerId, handle, startX: p.x, startY: p.y, lastX: p.x, lastY: p.y, moved: false, dragging: false };
  }

  function onPointerMove(e) {
    const p = local(e);
    if (pointers.has(e.pointerId)) pointers.set(e.pointerId, p);
    if (pinch && pointers.size >= 2) {
      const [a, b] = [...pointers.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
      zoomAt(pinch.cx, pinch.cy, dist / pinch.dist);
      camera.x -= (cx - pinch.cx) / camera.zoom;
      camera.y -= (cy - pinch.cy) / camera.zoom;
      pinch = { dist, cx, cy };
      settle();
      requestDraw();
      return;
    }
    if (!press) {
      if (h.onHover) {
        const world = screenToWorld(p.x, p.y);
        h.onHover(h.hitTest ? h.hitTest(world, p) : null, world, e);
      }
      return;
    }
    const dx = p.x - press.lastX, dy = p.y - press.lastY;
    if (!press.moved && Math.hypot(p.x - press.startX, p.y - press.startY) > DRAG_SLOP) {
      press.moved = true;
      press.dragging = !!(press.handle && h.canDrag && h.canDrag(press.handle));
    }
    press.lastX = p.x; press.lastY = p.y;
    if (!press.moved) return;
    if (press.dragging) {
      if (h.onDrag) h.onDrag(press.handle, screenToWorld(p.x, p.y), { dx: dx / camera.zoom, dy: dy / camera.zoom, event: e });
    } else {
      camera.x -= dx / camera.zoom;
      camera.y -= dy / camera.zoom;
      settle();
    }
    requestDraw();
  }

  function fireTap(handle, world, double) {
    if (h.onTap) h.onTap(handle, world, { double });
  }

  function onPointerUp(e) {
    pointers.delete(e.pointerId);
    canvas.releasePointerCapture?.(e.pointerId);
    if (pointers.size < 2) pinch = null;
    if (!press || press.id !== e.pointerId) return;
    const p = local(e);
    const travelled = Math.hypot(p.x - press.startX, p.y - press.startY);
    const { handle, dragging } = press;
    press = null;
    if (dragging) { if (h.onDragEnd) h.onDragEnd(handle); requestDraw(); return; }
    if (travelled > TAP_SLOP) return;
    const world = screenToWorld(p.x, p.y);
    const id = handle && h.idOf ? h.idOf(handle) : null;
    const now = performance.now();
    const isDouble = !!lastTap && now - lastTap.t < DOUBLE_TAP_MS
      && Math.hypot(p.x - lastTap.x, p.y - lastTap.y) < 24 && lastTap.id === id;
    if (isDouble) {
      if (deferTimer) { clearTimeout(deferTimer); deferTimer = 0; }
      lastTap = null;
      fireTap(handle, world, true);
      requestDraw();
      return;
    }
    lastTap = { t: now, x: p.x, y: p.y, id };
    // A node where both gestures are live (a project opens a surface AND
    // rings its children) holds its single tap for the double-tap window,
    // so the first half of a double-tap can't swap the surface out from
    // under the second half.
    if (h.deferSingleTap && h.deferSingleTap(handle)) {
      if (deferTimer) clearTimeout(deferTimer);
      deferTimer = setTimeout(() => { deferTimer = 0; fireTap(handle, world, false); requestDraw(); }, DOUBLE_TAP_MS);
      return;
    }
    fireTap(handle, world, false);
    requestDraw();
  }

  function onWheel(e) {
    e.preventDefault();
    const p = local(e);
    if (e.ctrlKey || e.metaKey) {
      zoomAt(p.x, p.y, Math.exp(-e.deltaY * 0.01));
      return;
    }
    camera.x += e.deltaX / camera.zoom;
    camera.y += e.deltaY / camera.zoom;
    settle();
    requestDraw();
  }

  function onKeyDown(e) {
    if (h.onKey && h.onKey(e)) { e.preventDefault(); e.stopPropagation(); }
  }

  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerup", onPointerUp);
  canvas.addEventListener("pointercancel", onPointerUp);
  canvas.addEventListener("wheel", onWheel, { passive: false });
  canvas.addEventListener("keydown", onKeyDown);
  canvas.addEventListener("contextmenu", (e) => e.preventDefault());

  // The owning module re-reads on `theme-changed` / `style-changed`;
  // the surface has no state handle of its own to subscribe with.
  const onTheme = () => { colors = readColors(); requestDraw(); };

  return {
    host, canvas, chrome, camera, ui,
    get colors() { return colors; },
    get size() { return { width, height }; },
    worldToScreen, screenToWorld, requestDraw, settle,
    refreshColors: onTheme,
    zoomAt,
    destroy() {
      destroyed = true;
      if (raf) cancelAnimationFrame(raf);
      if (deferTimer) clearTimeout(deferTimer);
      ro.disconnect();
      host.remove();
    },
  };
}
