/**
 * One finger on empty canvas pans; a finger held still first does what a
 * finger used to do.
 *
 * Before this, a finger dragged across empty canvas swept a marquee (or,
 * with something selected, carried the selection), so moving round a
 * notebook on an iPad needed two fingers — and two fingers zoom as well
 * as pan, so every move nudged the zoom. Now the press waits:
 *
 *   - it travels past `TOUCH_PAN_SLOP` first → a pan, zoom untouched;
 *   - it stays put for `TOUCH_HOLD_MS` → the press is handed to the
 *     canvas as it would have been all along (marquee, drag the
 *     selection, draw out a drag area), with a ring at the finger to say
 *     the hold took;
 *   - it lifts before either → a tap, delivered as down + up, so taps
 *     select, deselect, toggle checkboxes and place text as before.
 *
 * Only a press that lands on nothing is held back. A finger on a shape,
 * a handle, a split line or the pocket is direct manipulation and goes
 * through at once. Pen mode runs the same rule inside the stroke and
 * selection engines (stroke.js / selection.js delta #41), since there
 * the drawing overlay, not the canvas, receives the touches.
 */

export const TOUCH_HOLD_MS = 400;
/** Travel (CSS px) that turns a waiting press into a pan. The pen-mode
 *  engines use the same 8 px. */
export const TOUCH_PAN_SLOP = 8;

interface Pending {
  pointerId: number;
  down: PointerEvent;
  timer: ReturnType<typeof setTimeout>;
}

export interface TouchGateHost {
  /** Run the original pointer-down for a press the gate held back. */
  replay(down: PointerEvent): void;
  /** Start a one-finger pan anchored where the press landed. */
  beginPan(down: PointerEvent): void;
  /** The canvas, for pointer capture and the hold ring. */
  canvas(): HTMLCanvasElement | null;
}

export class TouchGate {
  private pending: Pending | null = null;
  private replaying = false;

  constructor(private host: TouchGateHost) {}

  /** Called first thing on pointer-down. True when the gate took the
   *  press (the caller stops there). `landsOnEmpty` is only asked about
   *  touches, and only when nothing is pending. */
  down(e: PointerEvent, landsOnEmpty: () => boolean): boolean {
    if (this.replaying || e.pointerType !== "touch") return false;
    if (this.pending) {
      // A second finger: the start of a two-finger gesture, which the
      // canvas's touch handlers own. The first press was never handed
      // on, so there is nothing to undo.
      this.cancel();
      return true;
    }
    if (e.button !== 0 || !landsOnEmpty()) return false;
    try { this.host.canvas()?.setPointerCapture(e.pointerId); } catch { /* pointer gone */ }
    const pending: Pending = {
      pointerId: e.pointerId,
      down: e,
      timer: setTimeout(() => {
        if (this.pending !== pending) return;
        this.pending = null;
        this.showHoldRing(e.clientX, e.clientY);
        this.release(e);
      }, TOUCH_HOLD_MS),
    };
    this.pending = pending;
    return true;
  }

  /** Pointer-move. True when the gate swallowed it. A press that has
   *  travelled far enough becomes a pan, and the move then falls through
   *  so the caller's pan branch applies it. */
  move(e: PointerEvent): boolean {
    const p = this.pending;
    if (!p || e.pointerId !== p.pointerId) return false;
    const dx = e.clientX - p.down.clientX;
    const dy = e.clientY - p.down.clientY;
    if (dx * dx + dy * dy < TOUCH_PAN_SLOP * TOUCH_PAN_SLOP) return true;
    clearTimeout(p.timer);
    this.pending = null;
    this.host.beginPan(p.down);
    return false;
  }

  /** Pointer-up / -cancel. True when the gate swallowed it. A press that
   *  lifts while still waiting is a tap: its down is delivered now and
   *  the up then falls through to complete it. A cancel is nothing. */
  up(e: PointerEvent): boolean {
    const p = this.pending;
    if (!p || e.pointerId !== p.pointerId) return false;
    clearTimeout(p.timer);
    this.pending = null;
    if (e.type === "pointercancel") return true;
    this.release(p.down);
    return false;
  }

  /** Drop a waiting press without delivering it (a multi-touch gesture
   *  took over, or the canvas is going away). */
  cancel(): void {
    if (!this.pending) return;
    clearTimeout(this.pending.timer);
    this.pending = null;
  }

  private release(down: PointerEvent): void {
    this.replaying = true;
    try { this.host.replay(down); }
    finally { this.replaying = false; }
  }

  /** A ring that swells and fades under the finger: the hold took. */
  private showHoldRing(clientX: number, clientY: number): void {
    const canvas = this.host.canvas();
    const parent = canvas?.parentElement;
    if (!canvas || !parent) return;
    const box = parent.getBoundingClientRect();
    const ring = document.createElement("div");
    ring.className = "nb-touch-hold-ring";
    ring.style.left = `${clientX - box.left}px`;
    ring.style.top = `${clientY - box.top}px`;
    parent.appendChild(ring);
    setTimeout(() => ring.remove(), 600);
  }
}
