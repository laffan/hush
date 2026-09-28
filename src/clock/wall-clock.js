/**
 * Wall clock — an analog clock floating over every surface, switched on
 * and off from the palette ("Toggle clock"). Twelve short 1 px marks, one
 * every five minutes, and two 3 px hands — the hour hand in the text
 * colour, the minute hand in the heading colour — turning round an empty
 * centre, on a disc of the window's background: invisible against a
 * document, a solid face over a canvas or a PDF. No numbers. It sits
 * above everything but Zen and the modal band (`--z-clock`).
 *
 * Drag it anywhere; the spot is kept with the toggle (clock-store.js),
 * so it survives a desk switch and a relaunch. A click on a mark sets the
 * alarm there, and that mark grows to twice the others' length — the
 * press counts anywhere in a band round the marks and resolves to the
 * nearest one by angle, since a 1 px line is no target. Clicking the
 * armed mark again clears it; there is one alarm at a time. Five minutes
 * before the minute hand reaches it, every line turns red; when it does,
 * they blink and the clock goes back to normal.
 */

import {
  getClock, moveClock, setClockAlarm, nextMinuteMark, ALARM_LEAD_MS, ALARM_STALE_MS,
} from "./clock-store.js";

const SVG_NS = "http://www.w3.org/2000/svg";

/** Geometry, in CSS px — all of it here, none in the stylesheet. The
 *  marks run inward from the rim at R_OUT, the armed one twice as far;
 *  the disc reaches HIT_PAD past the rim so the band that counts as
 *  clicking a mark is inside the element. The hands turn round an empty
 *  disc HUB_R in radius, so they never meet; their reach is to the end
 *  of the visible stroke, round cap included. */
const MARKS = 12;
const R_OUT = 51;
const MARK_LEN = 7.5;
const ALARM_MARK_LEN = 15;
const HIT_PAD = 5;
const SIZE = 2 * (R_OUT + HIT_PAD);
const C = SIZE / 2;
const HAND_WIDTH = 3;
const HUB_R = 10;
const MINUTE_HAND = 40;
const HOUR_HAND = 26;

/** Pointer travel that makes a press a drag rather than a click. */
const DRAG_SLOP = 4;

/** The blink — keep in step with `.wall-clock.alarm-ringing` in
 *  styles/clock.css. */
const BLINK_MS = 600;
const BLINKS = 4;

/** Room kept between the clock and the window's edges. */
const EDGE = 4;

const fmt = (n) => n.toFixed(2);

/** Mark `i` runs `len` inward from the rim. */
function setMarkLength(mark, i, len) {
  const a = (i * 2 * Math.PI) / MARKS;
  const sin = Math.sin(a);
  const cos = Math.cos(a);
  mark.setAttribute("x1", fmt(C + (R_OUT - len) * sin));
  mark.setAttribute("y1", fmt(C - (R_OUT - len) * cos));
  mark.setAttribute("x2", fmt(C + R_OUT * sin));
  mark.setAttribute("y2", fmt(C - R_OUT * cos));
}

function buildFace() {
  const el = document.createElement("div");
  el.className = "wall-clock";
  el.setAttribute("role", "img");
  el.style.width = el.style.height = `${SIZE}px`;
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", `0 0 ${SIZE} ${SIZE}`);
  svg.setAttribute("aria-hidden", "true");
  const marks = [];
  for (let i = 0; i < MARKS; i++) {
    const mark = document.createElementNS(SVG_NS, "line");
    mark.setAttribute("class", "wc-mark");
    setMarkLength(mark, i, MARK_LEN);
    svg.appendChild(mark);
    marks.push(mark);
  }
  // A round cap reaches half the stroke past each end, so both ends are
  // pulled in by that much: the stroke spans HUB_R to `reach`.
  const hand = (cls, reach) => {
    const line = document.createElementNS(SVG_NS, "line");
    line.setAttribute("class", cls);
    line.setAttribute("stroke-width", HAND_WIDTH);
    line.setAttribute("x1", C);
    line.setAttribute("y1", C - HUB_R - HAND_WIDTH / 2);
    line.setAttribute("x2", C);
    line.setAttribute("y2", C - reach + HAND_WIDTH / 2);
    svg.appendChild(line);
    return line;
  };
  const hour = hand("wc-hour", HOUR_HAND);
  const minute = hand("wc-minute", MINUTE_HAND);
  el.appendChild(svg);
  return { el, marks, hour, minute };
}

export function initWallClock(state) {
  let clock = getClock(state);
  let key = null;            // the settings the clock was last synced to
  let face = null;
  let tick = null;
  let press = null;          // { id, x, y, left, top, mark, dragging }
  let hovered = -1;
  let armed = -1;
  let ringingAt = null;      // the alarm whose blink is running
  let ringTimer = null;

  function mount() {
    face = buildFace();
    const { el } = face;
    // Neither half of a press may take focus: the caret stays wherever
    // the user was writing (WebKit sends `mousedown` even when
    // `pointerdown` is cancelled).
    el.addEventListener("mousedown", (e) => e.preventDefault());
    el.addEventListener("pointerdown", onDown);
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointercancel", onUp);
    el.addEventListener("pointerleave", () => { if (!press) setHover(-1); });
    document.body.appendChild(el);
    loop();
  }

  function teardown() {
    clearTimeout(tick);
    clearTimeout(ringTimer);
    tick = ringTimer = ringingAt = press = null;
    hovered = armed = -1;
    face?.el.remove();
    face = null;
  }

  // Wakes on each second boundary, so the alarm lands on its minute.
  function loop() {
    render();
    tick = setTimeout(loop, 1000 - (Date.now() % 1000));
  }

  /** Where the clock sits: the stored spot held inside the window, or
   *  the stylesheet's corner while it has never been moved. */
  function place(x, y) {
    const { style } = face.el;
    if (x == null || y == null) {
      style.left = style.top = style.right = "";
      return;
    }
    const maxX = Math.max(EDGE, window.innerWidth - SIZE - EDGE);
    const maxY = Math.max(EDGE, window.innerHeight - SIZE - EDGE);
    style.left = `${Math.min(Math.max(x, EDGE), maxX)}px`;
    style.top = `${Math.min(Math.max(y, EDGE), maxY)}px`;
    style.right = "auto";
  }

  function render() {
    if (!face) return;
    const now = Date.now();
    const d = new Date(now);
    const m = d.getMinutes() + d.getSeconds() / 60;
    const h = (d.getHours() % 12) + m / 60;
    face.minute.setAttribute("transform", `rotate(${fmt(m * 6)} ${C} ${C})`);
    face.hour.setAttribute("transform", `rotate(${fmt(h * 30)} ${C} ${C})`);

    if (ringingAt != null) return; // the blink runs its course
    // Read live rather than from `clock`: a write lands in `state.settings`
    // at once, but `sync` only hears of it once the save comes back, and
    // a tick in between would ring a just-cleared alarm a second time.
    const at = getClock(state).alarmAt;
    const until = at == null ? Infinity : at - now;
    face.el.classList.toggle("alarm-soon", until > 0 && until <= ALARM_LEAD_MS);
    if (until > 0) return;
    if (-until <= ALARM_STALE_MS) ring(at);
    else clearAlarm(at); // it went by while nobody could see it
  }

  function ring(at) {
    ringingAt = at;
    face.el.classList.add("alarm-soon", "alarm-ringing");
    ringTimer = setTimeout(() => {
      stopRinging();
      clearAlarm(at);
    }, BLINK_MS * BLINKS);
  }

  function stopRinging() {
    clearTimeout(ringTimer);
    ringTimer = ringingAt = null;
    face?.el.classList.remove("alarm-soon", "alarm-ringing");
  }

  /** Clear `at` if it is still the alarm — a sibling window, or a click,
   *  may already have cleared or replaced it. */
  function clearAlarm(at) {
    if (getClock(state).alarmAt === at) void setClockAlarm(state, null);
  }

  function setHover(i) {
    if (i === hovered) return;
    if (face && hovered >= 0) face.marks[hovered].classList.remove("hover");
    hovered = i;
    if (face && hovered >= 0) face.marks[hovered].classList.add("hover");
    face?.el.classList.toggle("over-mark", i >= 0);
  }

  /** The armed mark stands out by length as well as colour. */
  function armMark(i, on) {
    if (!face || i < 0) return;
    face.marks[i].classList.toggle("armed", on);
    setMarkLength(face.marks[i], i, on ? ALARM_MARK_LEN : MARK_LEN);
  }

  /** The mark a pointer is on, or -1 outside the band round the marks —
   *  from HIT_PAD inside the armed mark's inner end to HIT_PAD past the
   *  rim, so the armed mark can be hit anywhere along it. */
  function markAt(e) {
    const r = face.el.getBoundingClientRect();
    const dx = e.clientX - (r.left + r.width / 2);
    const dy = e.clientY - (r.top + r.height / 2);
    const dist = Math.hypot(dx, dy);
    if (dist < R_OUT - ALARM_MARK_LEN - HIT_PAD || dist > R_OUT + HIT_PAD) return -1;
    const turn = Math.atan2(dx, -dy) / (2 * Math.PI); // 0 at twelve, clockwise
    return ((Math.round(turn * MARKS) % MARKS) + MARKS) % MARKS;
  }

  function onDown(e) {
    if (e.button !== 0 || press) return;
    e.preventDefault();
    const r = face.el.getBoundingClientRect();
    press = { id: e.pointerId, x: e.clientX, y: e.clientY, left: r.left, top: r.top, mark: markAt(e), dragging: false };
    face.el.setPointerCapture(e.pointerId);
  }

  function onMove(e) {
    if (!press) { setHover(markAt(e)); return; }
    if (e.pointerId !== press.id) return;
    const dx = e.clientX - press.x;
    const dy = e.clientY - press.y;
    if (!press.dragging) {
      if (Math.hypot(dx, dy) < DRAG_SLOP) return;
      press.dragging = true;
      face.el.classList.add("dragging");
      setHover(-1);
    }
    place(press.left + dx, press.top + dy);
  }

  function onUp(e) {
    if (!press || e.pointerId !== press.id) return;
    const p = press;
    press = null;
    face.el.classList.remove("dragging");
    if (p.dragging) {
      const r = face.el.getBoundingClientRect();
      void moveClock(state, Math.round(r.left), Math.round(r.top));
    } else if (e.type === "pointerup" && p.mark >= 0) {
      const minute = p.mark * (60 / MARKS);
      void setClockAlarm(state, p.mark === armedMark(getClock(state)) ? null : nextMinuteMark(minute));
    }
  }

  /** The mark holding the alarm, or -1. An alarm off the five-minute
   *  grid (set when every minute had a mark) still rings; it just has no
   *  mark to show it. */
  function armedMark(c) {
    if (c.alarmAt == null) return -1;
    const minute = new Date(c.alarmAt).getMinutes();
    return minute % (60 / MARKS) === 0 ? minute / (60 / MARKS) : -1;
  }

  function sync() {
    const next = getClock(state);
    const nextKey = JSON.stringify(next);
    if (nextKey === key) return;
    key = nextKey;
    clock = next;
    if (!clock.visible) { teardown(); return; }
    if (!face) mount();
    if (!press?.dragging) place(clock.x, clock.y);
    if (ringingAt != null && clock.alarmAt !== ringingAt) stopRinging();
    armMark(armed, false);
    armed = armedMark(clock);
    armMark(armed, true);
    face.el.setAttribute("aria-label", clock.alarmAt == null ? "Clock"
      : `Clock, alarm at ${new Intl.DateTimeFormat([], { hour: "numeric", minute: "2-digit" }).format(clock.alarmAt)}`);
    render();
  }

  // Timers in a background window are throttled; catch up the moment
  // the window is looked at again.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") render();
  });
  window.addEventListener("resize", () => {
    if (face && !press?.dragging) place(clock.x, clock.y);
  });
  // A sibling window's toggle, drag or alarm arrives as a settings merge,
  // which emits `settings-changed` too.
  state.on("settings-changed", sync);
  sync();
}
