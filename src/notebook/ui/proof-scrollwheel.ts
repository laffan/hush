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
 *   - Dragging the face down rolls the wheel toward you, which advances
 *     the document downward — the same direction a notched wheel sends
 *     the page, and the opposite of a drag-to-scroll surface where the
 *     content follows the finger.
 *   - Letting go of a flick leaves the flywheel spinning, decaying under
 *     friction rather than stopping dead.
 *   - Touching a spinning wheel stops it, exactly like putting a finger
 *     on one that's still coasting. That press is also the start of the
 *     next drag, so grab-and-reposition works in one gesture.
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

/** Offset from the top of the window / left edge, before safe-area and
 *  docked-pane insets are folded in. */
const WHEEL_TOP = 30;
const WHEEL_LEFT = 10;

/** Document px travelled per px of finger travel. A real wheel's face
 *  moves a fraction of the distance the page does; below ~2 the wheel
 *  feels like a stiff scrollbar, and much above 3 a small flick throws
 *  the proof several pages. */
const GAIN = 2.4;

/** Velocity retained per 60 Hz frame while coasting. 0.94 gives a flick
 *  roughly two seconds of travel — long enough to read as a flywheel,
 *  short enough not to feel out of control on a 50-page proof. */
const FRICTION = 0.94;

/** Below this (document px per ms) the flywheel has stopped. */
const MIN_VELOCITY = 0.02;

/** Ignore samples older than this when estimating release velocity, so
 *  the throw reflects the end of the gesture and not its average. */
const VELOCITY_WINDOW_MS = 90;

/** Cap on release velocity (document px per ms) — a fast fling on a
 *  high-rate display can otherwise report a spike that sends the camera
 *  most of a document away in one coast. */
const MAX_VELOCITY = 6;

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
  // makes the wheel look like it is turning. Shading sits in a separate
  // non-interactive overlay so the ridge gradient can move underneath a
  // fixed cylinder highlight.
  const drum = h("div", {
    style: {
      position: "absolute", left: "0", top: "0", right: "0", bottom: "0",
      borderRadius: "9px",
    },
  });
  const shade = h("div", {
    style: {
      position: "absolute", left: "0", top: "0", right: "0", bottom: "0",
      borderRadius: "9px", pointerEvents: "none",
      // Cylinder: dark at both edges, bright down the middle. Overlaid on
      // the ridges so they dim into the wheel's shoulders instead of
      // running flat across it.
      background:
        "linear-gradient(to right, rgba(0,0,0,0.28) 0%, rgba(0,0,0,0.05) 22%,"
        + " rgba(255,255,255,0.16) 50%, rgba(0,0,0,0.05) 78%, rgba(0,0,0,0.28) 100%)",
    },
  });

  const root = h("div", {
    style: {
      position: "absolute",
      top: `calc(env(safe-area-inset-top) + ${WHEEL_TOP}px + var(--pane-dock-top-height, 0px))`,
      left: `calc(env(safe-area-inset-left) + ${WHEEL_LEFT}px + var(--pane-dock-left-width, 0px))`,
      width: `${WHEEL_WIDTH}px`, height: `${WHEEL_HEIGHT}px`,
      display: "none", boxSizing: "border-box",
      borderRadius: "10px", overflow: "hidden",
      // Above the toolbar (100) so a centred bar can't bury it, below the
      // shelf (150) which lives on the opposite edge anyway.
      zIndex: "120",
      boxShadow: "0 2px 12px rgba(0,0,0,0.18)",
      // The wheel owns its touches outright — no browser panning, no
      // synthetic scroll, no long-press callout.
      touchAction: "none", userSelect: "none", webkitUserSelect: "none",
      cursor: "ns-resize",
    } as Partial<CSSStyleDeclaration>,
    children: [drum, shade],
  });
  root.classList.add("notebook-proof-wheel");

  /** Position of the wheel face, in face px. Only its remainder against
   *  RIDGE_PERIOD is ever used, but keeping the running total means the
   *  ridges never jump when a drag and a coast hand off to each other. */
  let facePos = 0;
  /** Document px per ms while coasting; 0 when at rest. */
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

  /** Advance the document by `docDy` px (positive = further down the
   *  page) and turn the wheel by the matching amount of face travel. */
  function advance(docDy: number) {
    if (!docDy) return;
    state.camera = { ...state.camera, y: state.camera.y - docDy };
    state.notify("camera");
    facePos += docDy / GAIN;
    drum.style.backgroundPositionY = `${facePos % RIDGE_PERIOD}px`;
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
    advance(velocity * dt);
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
    samples.push({ t: performance.now(), y: 0 });
    root.setPointerCapture(e.pointerId);
  }

  function onPointerMove(e: PointerEvent) {
    if (dragPointer !== e.pointerId) return;
    e.preventDefault();
    const faceDy = e.clientY - dragLastY;
    dragLastY = e.clientY;
    if (faceDy) advance(faceDy * GAIN);
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
    if (last && first && last.t > first.t) {
      // Face velocity over the tail of the gesture, converted back into
      // document px so the coast continues at the speed the drag ended.
      startCoast(((last.y - first.y) / (last.t - first.t)) * GAIN);
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

  /** The wheel exists to replace hardware the device doesn't have. A
   *  desktop already has a wheel; a pane-hosted or gutter-docked canvas
   *  scrolls with its host; a notebook that isn't a proof isn't the long
   *  document this was built for. */
  function shouldShow(): boolean {
    if (!isIOS()) return false;
    if (!state.proof) return false;
    if (state.paneHosted) return false;
    if (state.gutterScrollDOM) return false;
    return true;
  }

  function update() {
    const next = shouldShow();
    if (next !== visible) {
      visible = next;
      root.style.display = next ? "block" : "none";
      if (!next) stopCoast();
    }
    if (visible) applySkin();
  }

  const onChange = () => update();
  state.addEventListener("change", onChange);
  update();

  return {
    root,
    destroy() {
      state.removeEventListener("change", onChange);
      stopCoast();
      root.remove();
    },
  };
}
