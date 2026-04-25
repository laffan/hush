import type { DrawingState } from "../state";
import type { Point, TextShape } from "../types";
import { canvasToScreen, generateId, getShapeBounds, screenToCanvas } from "../utils";
import { h } from "./dom-helpers";

/** Minimum gap (in canvas px) between a brainstorm card's bounds and
 *  any neighbouring shape's bounds. */
const BRAINSTORM_PADDING = 24;

/**
 * Brainstorm mode: a persistent text input that stays at a click location.
 * Each Enter press creates a text shape placed in an expanding spiral
 * around the input position. The input stays open for rapid entry.
 */
export function createBrainstormInput(state: DrawingState): HTMLElement {
  const container = h("div", {
    style: { position: "absolute", zIndex: "250", display: "none", pointerEvents: "auto" },
  });

  const inputRow = h("div", {
    style: {
      display: "flex", alignItems: "center", gap: "0",
      background: "#fff", borderRadius: "8px",
      boxShadow: "0 2px 8px rgba(0,0,0,0.15)",
      border: "1px solid #4285f4",
      overflow: "hidden",
    },
  });

  const input = document.createElement("input");
  input.type = "text";
  input.placeholder = "Press enter";
  Object.assign(input.style, {
    width: "200px", padding: "6px 10px", border: "none", outline: "none",
    fontSize: "14px", fontFamily: "inherit", background: "transparent",
  });

  const closeBtn = h("button", {
    text: "×",
    style: {
      width: "32px", height: "32px", border: "none", borderLeft: "1px solid #e5e7eb",
      background: "#f8f9fa", cursor: "pointer", fontSize: "16px", color: "#999",
      display: "flex", alignItems: "center", justifyContent: "center", flexShrink: "0",
    },
    onClick: () => hide(),
  });

  inputRow.appendChild(input);
  inputRow.appendChild(closeBtn);
  container.appendChild(inputRow);

  // Track placement state
  let canvasOrigin: Point = { x: 0, y: 0 }; // canvas-space origin of the input
  let visible = false;

  function show(screenX: number, screenY: number) {
    canvasOrigin = screenToCanvas({ x: screenX, y: screenY }, state.camera);
    container.style.display = "block";
    container.style.left = screenX + "px";
    container.style.top = screenY + "px";
    visible = true;
    setTimeout(() => input.focus(), 20);
  }

  function hide() {
    if (!visible) return;
    container.style.display = "none";
    visible = false;
    input.value = "";
    state.brainstormMode = false;
    state.tool = "select";
    state.notify("brainstormMode");
    state.notify("tool");
  }

  function updatePosition() {
    if (!visible) return;
    const screenPos = canvasToScreen(canvasOrigin, state.camera);
    container.style.left = screenPos.x + "px";
    container.style.top = screenPos.y + "px";
  }

  // Submit on Enter
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      const text = input.value.trim();
      if (!text) return;

      // Build the prospective shape (without a position) so we can
      // measure how big its bounding box will be at this canvas's
      // current font, then find a spot that fits without overlap.
      const draft: TextShape = {
        id: generateId(),
        type: "text",
        position: { x: 0, y: 0 },
        text,
        fontSize: state.fontSize,
        color: state.color,
        width: state.maxTextWidth,
        layerId: state.activeLayerId,
      };
      const pos = findBrainstormPosition(canvasOrigin, draft, state);
      draft.position = pos;
      state.shapes = [...state.shapes, draft];
      state.recordHistory();
      state.notify("shapes");

      input.value = "";
      input.focus();
    }
    if (e.key === "Escape") {
      hide();
    }
  });

  // Prevent canvas pointer events from stealing focus
  container.addEventListener("pointerdown", (e) => e.stopPropagation());

  // Listen for brainstorm mode + click on canvas
  // The state handler sets brainstormMode but we intercept canvas clicks here
  function handleCanvasClick(e: PointerEvent) {
    if (!state.brainstormMode) { if (visible) hide(); return; }
    if (e.button !== 0) return;

    // Don't intercept if clicking on UI elements
    const target = e.target as HTMLElement;
    if (target.closest("button") || target.closest("input") || target.tagName === "INPUT") return;

    const canvas = state.canvasEl;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const screenX = e.clientX - rect.left;
    const screenY = e.clientY - rect.top;

    if (visible) {
      // Move the input to the new click location
      show(screenX, screenY);
    } else {
      show(screenX, screenY);
    }
  }

  // Update position when camera moves
  state.addEventListener("change", (ev) => {
    const detail = (ev as CustomEvent).detail;
    if (detail?.keys?.includes("camera")) updatePosition();
    if (detail?.keys?.includes("brainstormMode") && !state.brainstormMode) hide();
  });

  // We need to register the click handler on the canvas — but it doesn't exist yet.
  // Do it after the canvas is set.
  const checkCanvas = setInterval(() => {
    if (state.canvasEl) {
      state.canvasEl.addEventListener("pointerdown", handleCanvasClick, { capture: true });
      clearInterval(checkCanvas);
    }
  }, 50);

  return container;
}

/**
 * Find a non-overlapping position for a brainstorm card around the
 * given origin. Approach:
 *
 *  1. Compute the draft shape's actual rendered bounds at every
 *     candidate position (via getShapeBounds) — this is the accurate
 *     bbox the card will occupy once placed.
 *  2. Walk an Archimedean-style spiral outward (angle increments
 *     decrease as the radius grows so ring density stays consistent).
 *     Each candidate is the centre of where the card should sit; we
 *     translate so the card's bbox is centred there.
 *  3. Reject any candidate whose padded bbox intersects any existing
 *     shape's bbox (pocketed shapes excluded — they live in screen
 *     space, not the canvas).
 *  4. The very first card lands at the origin (the input's anchor)
 *     unless something is already there; ensures a fresh brainstorm
 *     drops its first card at the user's exact click point.
 */
function findBrainstormPosition(
  origin: Point,
  draft: TextShape,
  state: DrawingState,
): Point {
  const fontFamily = state.fontFamily;
  const otherBounds = state.shapes
    .filter((s) => !s.pocketed)
    .map((s) => getShapeBounds(s, fontFamily));

  // The brainstorm input is anchored at `origin` in screen space. We
  // model it as an exclusion bbox in canvas coords so the first card
  // doesn't land underneath it. Width / height are the input's
  // approximate footprint (200px input + 32px close button + a bit of
  // chrome ≈ 240×40 in screen px → divided by zoom for canvas px).
  const zoom = state.camera.zoom || 1;
  const inputW = 240 / zoom;
  const inputH = 40 / zoom;
  const inputBounds = {
    minX: origin.x - inputW / 2,
    minY: origin.y - inputH / 2,
    maxX: origin.x + inputW / 2,
    maxY: origin.y + inputH / 2,
  };
  const blockers = [inputBounds, ...otherBounds];

  // Pre-compute draft's intrinsic size — it doesn't depend on
  // position, so we measure once and translate per candidate.
  const sized = getShapeBounds({ ...draft, position: { x: 0, y: 0 } }, fontFamily);
  const w = sized.maxX - sized.minX;
  const h = sized.maxY - sized.minY;

  const tryAt = (cx: number, cy: number): { pos: Point; ok: boolean } => {
    const pos: Point = { x: cx - w / 2, y: cy - h / 2 };
    const candidate = { minX: pos.x, minY: pos.y, maxX: pos.x + w, maxY: pos.y + h };
    const ok = !blockers.some((b) =>
      b.minX < candidate.maxX + BRAINSTORM_PADDING &&
      b.maxX > candidate.minX - BRAINSTORM_PADDING &&
      b.minY < candidate.maxY + BRAINSTORM_PADDING &&
      b.maxY > candidate.minY - BRAINSTORM_PADDING,
    );
    return { pos, ok };
  };

  // Spiral outwards. The minimum radius is set so the first card
  // clears the input box (its half-diagonal + padding + half the
  // card's diagonal). Angle step shrinks with radius so candidate
  // arc-length stays roughly constant.
  const cardHalfDiag = Math.sqrt(w * w + h * h) / 2;
  const inputHalfDiag = Math.sqrt(inputW * inputW + inputH * inputH) / 2;
  const minRadius = inputHalfDiag + cardHalfDiag + BRAINSTORM_PADDING;
  const maxRadius = Math.max(minRadius * 30, 4000);
  const radiusStep = Math.max(20, Math.min(40, Math.max(w, h) * 0.25));
  for (let r = minRadius; r <= maxRadius; r += radiusStep) {
    // ~28px arc length between samples → angleStep = 28/r radians.
    // Clamped so very small radii don't degenerate into all-direction
    // tries (and very large radii don't sample wastefully fine).
    const angleStep = Math.max(0.06, Math.min(Math.PI / 6, 28 / r));
    // Per-ring random phase + jitter so consecutive cards don't snap
    // to the same compass direction once one ring is full. Pure
    // determinism here would line them up like a clock face, which
    // looks robotic; this gives the "scattered around" feel the user
    // asked for while still following the spiral envelope.
    const phase = Math.random() * Math.PI * 2;
    for (let a = 0; a < Math.PI * 2; a += angleStep) {
      const angle = phase + a;
      const cx = origin.x + Math.cos(angle) * r;
      const cy = origin.y + Math.sin(angle) * r;
      const t = tryAt(cx, cy);
      if (t.ok) return t.pos;
    }
  }

  // Pathological fallback — the canvas is so densely packed we
  // couldn't find any open spot inside the search envelope. Drop the
  // card far enough that it certainly clears.
  const angle = Math.random() * Math.PI * 2;
  return {
    x: origin.x + Math.cos(angle) * (maxRadius + 200),
    y: origin.y + Math.sin(angle) * (maxRadius + 200),
  };
}

