/**
 * Virtual scroll wheel for proofread notebooks on iPad.
 *
 * A proof is a long document read top to bottom, and on iPad there is no
 * good way to travel it: the trackpad's two-finger swipe doesn't behave
 * like a Mac's, and two fingers on the canvas are already spoken for by
 * pan and pinch. So the notebook grows the control the hardware is
 * missing — a weighted wheel parked in the top-left corner, driving the
 * camera's vertical axis and nothing else.
 *
 * It is modelled on the physical object rather than on a scrollbar:
 *
 *   - Letting go of a flick leaves the flywheel spinning, decaying under
 *     friction rather than stopping dead.
 *   - Touching a spinning wheel stops it, exactly like putting a finger
 *     on one that's still coasting. That press is also the start of the
 *     next drag, so grab-and-reposition works in one gesture.
 *   - The ridges turn with the throw, so the wheel's own state is
 *     visible even when the document underneath has nowhere left to go.
 *
 * The one place it deliberately breaks the model is direction: it
 * follows the platform's "natural" scrolling (content tracks the finger)
 * rather than a notched wheel's opposite convention — see `DIRECTION`.
 *
 * iPad / iPhone only, and only on a proofread notebook: everywhere else
 * the platform already has an answer and the corner is better left
 * empty.
 */

import type { DrawingState } from "../state";
import { h } from "./dom-helpers";
// @ts-ignore — sibling JS module, no type declaration file
import { isIOS } from "../../settings/settings-ui.js";

export const WHEEL_WIDTH = 50;
export const WHEEL_HEIGHT = 200;

/** Offset from the top of the host box, before safe-area and
 *  docked-pane insets are folded in. */
const WHEEL_TOP = 0;

/** Clearance from the left, measured from the *inside* edge of the file
 *  sidebar's always-present grip strip rather than from the window —
 *  otherwise the closed sidebar's grip clips the wheel's first 10 px and
 *  takes those touches with it. */
const WHEEL_LEFT = 10;

/** Clearance from the host's own corner when the canvas is hosted in a
 *  pane or stack column: there's no safe-area band or sidebar grip to
 *  measure from there, just the box. Applied on both axes so the wheel
 *  clears a docked pane's floating title pill as well as its edge. */
const WHEEL_PANE_INSET = 10;

/** The wheel is a fixed 50 × 200 control, and a host box that can't
 *  spare the room for it doesn't want one: it would sit across the
 *  document it exists to travel. Panes go down to 60 px tall, so this
 *  is the difference between a proof pane growing a wheel and a proof
 *  pane being covered by one. */
const MIN_HOST_HEIGHT = WHEEL_PANE_INSET + WHEEL_HEIGHT + 24;
const MIN_HOST_WIDTH = WHEEL_PANE_INSET + WHEEL_WIDTH + 120;

/** Document px travelled per px of finger travel. A real wheel's face
 *  moves a fraction of the distance the page does; below ~2 the wheel
 *  feels like a stiff scrollbar, and much above 3 a small flick throws
 *  the proof several pages. */
const GAIN = 2.4;

/** Sign relating face travel to document travel. Negative = "natural"
 *  scrolling: the content follows the finger, so dragging the face DOWN
 *  moves you back up the document. That contradicts a physical wheel,
 *  where rolling the face toward you sends the page down — but the
 *  platform's own direction is the one the hand already knows, and the
 *  wheel is being used alongside trackpad scrolling that obeys it. */
const DIRECTION = -1;

/** Velocity retained per 60 Hz frame while coasting. 0.94 gives a flick
 *  roughly two seconds of travel — long enough to read as a flywheel,
 *  short enough not to feel out of control on a 50-page proof. */
const FRICTION = 0.94;

/** Below this (face px per ms) the flywheel has stopped. */
const MIN_VELOCITY = 0.01;

/** Ignore samples older than this when estimating release velocity, so
 *  the throw reflects the end of the gesture and not its average. */
const VELOCITY_WINDOW_MS = 90;

/** Cap on release velocity (face px per ms) — a fast fling on a
 *  high-rate display can otherwise report a spike that sends the camera
 *  most of a document away in one coast. */
const MAX_VELOCITY = 2.5;

/** Spacing of the drum's ridges, in px of wheel face. */
const RIDGE_PERIOD = 13;

export interface ProofScrollWheel {
  root: HTMLElement;
  destroy(): void;
}

/** Nominal 60 Hz frame, used to convert FRICTION into a per-ms decay. */
const FRAME_MS = 1000 / 60;

export function createProofScrollWheel(state: DrawingState): ProofScrollWheel {
  // The drum carries the ridges; sliding its background position is what
  // makes the wheel look like it is turning. No cylinder shading over
  // them — the ridges moving is the whole read, and the gradient only
  // muddied it.
  const drum = h("div", {
    style: {
      position: "absolute", left: "0", top: "0", right: "0", bottom: "0",
      borderRadius: "9px",
    },
  });

  const root = h("div", {
    style: {
      // Placement is written by `applyPlacement` on the first update:
      // it depends on `state.paneHosted`, which the host sets after this
      // constructor has already run.
      position: "absolute",
      width: `${WHEEL_WIDTH}px`, height: `${WHEEL_HEIGHT}px`,
      display: "none", boxSizing: "border-box",
      borderRadius: "10px", overflow: "hidden",
      // Below the file sidebar (100) on purpose: an open sidebar should
      // bury the wheel rather than have it sitting on top of the file
      // tree. `#notebook-container` deliberately creates no stacking
      // context, so this number really is compared against the
      // sidebar's. Still above floating panes (90) — and a left-docked
      // pane pushes the wheel clear of itself via `--pane-dock-left-width`
      // anyway. Nothing else in the notebook shares this corner.
      zIndex: "95",
      boxShadow: "0 2px 12px rgba(0,0,0,0.18)",
      // The wheel owns its touches outright — no browser panning, no
      // synthetic scroll, no long-press callout.
      touchAction: "none", userSelect: "none", webkitUserSelect: "none",
      cursor: "ns-resize",
    } as Partial<CSSStyleDeclaration>,
    children: [drum],
  });
  root.classList.add("notebook-proof-wheel");

  /** Position of the wheel face, in face px. Only its remainder against
   *  RIDGE_PERIOD is ever used, but keeping the running total means the
   *  ridges never jump when a drag and a coast hand off to each other. */
  let facePos = 0;
  /** Face px per ms while coasting; 0 when at rest. */
  let velocity = 0;
  let coastRaf = 0;
  let coastLast = 0;
  let dragPointer: number | null = null;
  let dragLastY = 0;
  /** Recent (timestamp, face position) samples for the release throw. */
  const samples: { t: number; y: number }[] = [];
  let lastSkin = "";
  let visible = false;

  // ── motion ──

  /** Turn the wheel by `faceDy` px of face travel and move the document
   *  the matching distance. Everything upstream — drag deltas, coast
   *  velocity, the release samples — is in face px, so `DIRECTION` and
   *  `GAIN` are applied in exactly one place. */
  function turn(faceDy: number) {
    if (!faceDy) return;
    facePos += faceDy;
    drum.style.backgroundPositionY = `${facePos % RIDGE_PERIOD}px`;
    const docDy = faceDy * GAIN * DIRECTION;
    state.camera = { ...state.camera, y: state.camera.y - docDy };
    state.notify("camera");
  }

  function stopCoast() {
    velocity = 0;
    if (coastRaf) { cancelAnimationFrame(coastRaf); coastRaf = 0; }
  }

  function coast(now: number) {
    coastRaf = 0;
    // Clamp the step: a backgrounded tab resumes with a huge dt, and an
    // un-clamped one would teleport the camera on the first frame back.
    const dt = Math.min(64, Math.max(1, now - coastLast));
    coastLast = now;
    turn(velocity * dt);
    velocity *= Math.pow(FRICTION, dt / FRAME_MS);
    if (Math.abs(velocity) < MIN_VELOCITY) { velocity = 0; return; }
    coastRaf = requestAnimationFrame(coast);
  }

  function startCoast(v: number) {
    velocity = Math.max(-MAX_VELOCITY, Math.min(MAX_VELOCITY, v));
    if (Math.abs(velocity) < MIN_VELOCITY) { velocity = 0; return; }
    coastLast = performance.now();
    coastRaf = requestAnimationFrame(coast);
  }

  // ── input ──

  function onPointerDown(e: PointerEvent) {
    if (dragPointer !== null) return;
    e.preventDefault();
    e.stopPropagation();
    // A press on a spinning wheel stops it — and then becomes the drag,
    // so catching a runaway flick and re-aiming it is one gesture.
    stopCoast();
    dragPointer = e.pointerId;
    dragLastY = e.clientY;
    samples.length = 0;
    // Seed with the CURRENT face position, not zero. `facePos` is a
    // running total that never resets, so a zero here made the release
    // velocity read as "the wheel travelled its whole lifetime's
    // distance during this flick" — huge, and signed by wherever the
    // document happened to be. Catching a coast and nudging it could
    // therefore fling it off in the opposite direction.
    samples.push({ t: performance.now(), y: facePos });
    root.setPointerCapture(e.pointerId);
  }

  function onPointerMove(e: PointerEvent) {
    if (dragPointer !== e.pointerId) return;
    e.preventDefault();
    const faceDy = e.clientY - dragLastY;
    dragLastY = e.clientY;
    if (faceDy) turn(faceDy);
    const t = performance.now();
    samples.push({ t, y: facePos });
    // Keep one sample older than the window so a slow final frame still
    // has something to difference against.
    while (samples.length > 2 && t - samples[1].t > VELOCITY_WINDOW_MS) samples.shift();
  }

  function onPointerUp(e: PointerEvent) {
    if (dragPointer !== e.pointerId) return;
    dragPointer = null;
    if (root.hasPointerCapture(e.pointerId)) root.releasePointerCapture(e.pointerId);
    const last = samples[samples.length - 1];
    const first = samples[0];
    // A release with no travel since the press (a tap to stop a coast)
    // leaves first === last, so no throw is started — which is what makes
    // "press to stop" stick.
    if (last && first && last.t > first.t) {
      startCoast((last.y - first.y) / (last.t - first.t));
    }
    samples.length = 0;
  }

  function onPointerCancel(e: PointerEvent) {
    if (dragPointer !== e.pointerId) return;
    dragPointer = null;
    samples.length = 0;
  }

  root.addEventListener("pointerdown", onPointerDown);
  root.addEventListener("pointermove", onPointerMove);
  root.addEventListener("pointerup", onPointerUp);
  root.addEventListener("pointercancel", onPointerCancel);

  // ── appearance ──

  function applySkin() {
    const t = state.theme;
    const skin = `${t.uiBackground}|${t.uiBorder}|${t.foreground}`;
    if (skin === lastSkin) return;
    lastSkin = skin;
    root.style.border = `1px solid ${t.uiBorder}`;
    root.style.background = t.uiBackground;
    // Ridges are drawn from the theme's own foreground at low alpha, so
    // the wheel reads as machined metal in a light theme and as a dark
    // knurled drum in a dark one without carrying its own palette.
    const ridge = t.variant === "dark" ? "rgba(255,255,255,0.20)" : "rgba(0,0,0,0.20)";
    drum.style.background =
      `repeating-linear-gradient(to bottom, ${ridge} 0px, ${ridge} 1px,`
      + ` transparent 1px, transparent ${RIDGE_PERIOD}px)`;
    drum.style.backgroundColor = t.uiBackground;
    drum.style.backgroundPositionY = `${facePos % RIDGE_PERIOD}px`;
  }

  // ── visibility ──

  /** Park the wheel against the host's own top-left corner.
   *
   *  Window chrome is only the wheel's business when the canvas owns the
   *  window. Inside a pane or a stack column the host box *is* the
   *  screen as far as this control is concerned — its left edge is the
   *  edge to park against, and the sidebar grip, safe-area bands and
   *  dock footprints have already been carved out of the box by whoever
   *  laid the host out. Folding them in a second time would push the
   *  wheel across the pane it's sitting in. */
  let lastTop = "";
  let lastLeft = "";
  function applyPlacement() {
    const top = state.paneHosted
      ? `${WHEEL_PANE_INSET}px`
      : `calc(env(safe-area-inset-top) + ${WHEEL_TOP}px + var(--pane-dock-top-height, 0px))`;
    // `--sidebar-grip-width` is also the file sidebar's collapsed width,
    // so the window form clears the grip when the sidebar is closed and
    // lands squarely underneath the sidebar when it's open — which, with
    // the z-index above, is how the wheel gets covered instead of
    // floating over the file tree.
    const left = state.paneHosted
      ? `${WHEEL_PANE_INSET}px`
      : `calc(env(safe-area-inset-left) + var(--sidebar-grip-width, 20px) + ${WHEEL_LEFT}px`
        + ` + var(--pane-dock-left-width, 0px))`;
    // Guarded writes: `update` runs on every state change, and an
    // unconditional style write costs a style recalc each time.
    if (top !== lastTop) { root.style.top = top; lastTop = top; }
    if (left !== lastLeft) { root.style.left = left; lastLeft = left; }
  }

  /** Whether the host box has room for the control. An unmounted or
   *  zero-size host (an inactive pane is `display: none`) reads as
   *  roomy: there's nothing to measure, and hiding on a hidden host
   *  would only make the wheel flicker back on when it reappears. */
  function hostFits(): boolean {
    const host = root.parentElement;
    if (!host) return true;
    const r = host.getBoundingClientRect();
    if (!r.width || !r.height) return true;
    return r.height >= MIN_HOST_HEIGHT && r.width >= MIN_HOST_WIDTH;
  }

  /** The wheel exists to replace hardware the device doesn't have. A
   *  desktop already has a wheel; a gutter-docked canvas is scroll-locked
   *  to the document beside it, so its camera isn't the wheel's to
   *  drive; a notebook that isn't a proof isn't the long document this
   *  was built for. A pane *is* in scope — a proof read in a pane
   *  travels exactly like a proof read full-screen. */
  function shouldShow(): boolean {
    if (!isIOS()) return false;
    if (!state.proof) return false;
    if (state.gutterScrollDOM) return false;
    return hostFits();
  }

  function update() {
    const next = shouldShow();
    if (next !== visible) {
      visible = next;
      root.style.display = next ? "block" : "none";
      if (!next) stopCoast();
    }
    if (visible) { applyPlacement(); applySkin(); }
  }

  const onChange = () => update();
  state.addEventListener("change", onChange);

  // A pane resize changes whether the wheel fits, and emits no canvas
  // state change to ride on.
  let ro: ResizeObserver | null = null;
  if (typeof ResizeObserver !== "undefined") {
    ro = new ResizeObserver(() => update());
    // The host appends `root` right after this constructor returns.
    requestAnimationFrame(() => { if (root.parentElement) ro?.observe(root.parentElement); });
  }

  update();

  return {
    root,
    destroy() {
      state.removeEventListener("change", onChange);
      ro?.disconnect();
      stopCoast();
      root.remove();
    },
  };
}
