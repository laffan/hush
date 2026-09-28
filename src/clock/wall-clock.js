/**
 * Wall clock — an analog clock floating over every surface, switched on
 * and off from the palette ("Toggle clock"). Sixty 1 px minute marks, an
 * hour hand in the text colour and a minute hand in the heading colour,
 * on a disc of the window's background: invisible against a document, a
 * solid face over a canvas or a PDF. No numbers. It sits above
 * everything but Zen and the modal band (`--z-clock`).
 *
 * Drag it anywhere; the spot is kept with the toggle (clock-store.js),
 * so it survives a desk switch and a relaunch. A click on a minute mark
 * sets the alarm there — the press counts anywhere in a band a few px
 * either side of the marks and resolves to the nearest one by angle, since
 * a 1 px line is no target. Clicking the armed mark again clears it; there
 * is one alarm at a time. Five minutes before the minute hand reaches it,
 * every line turns red; when it does, they blink and the clock goes back
 * to normal.
 */

import {
  getClock, moveClock, setClockAlarm, nextMinuteMark, ALARM_LEAD_MS, ALARM_STALE_MS,
} from "./clock-store.js";

const SVG_NS = "http://www.w3.org/2000/svg";

/** Geometry, in CSS px. The marks run from R_IN to R_OUT; the disc
 *  reaches HIT_PAD past them so the band that counts as clicking a mark
 *  is inside the element on both sides. */
const R_OUT = 64;
const MARK_LEN = 15;
const R_IN = R_OUT - MARK_LEN;
const HIT_PAD = 6;
const SIZE = 2 * (R_OUT + HIT_PAD);
const C = SIZE / 2;
const MINUTE_HAND = R_IN - 5;
const HOUR_HAND = 28;

/** Pointer travel that makes a press a drag rather than a click. */
const DRAG_SLOP = 4;

/** The blink — keep in step with `.wall-clock.alarm-ringing` in
 *  styles/clock.css. */
const BLINK_MS = 600;
const BLINKS = 4;

/** Room kept between the clock and the window's edges. */
const EDGE = 4;

const fmt = (n) => n.toFixed(2);

function buildFace() {
  const el = document.createElement("div");
  el.className = "wall-clock";
  el.setAttribute("role", "img");
  el.style.width = el.style.height = `${SIZE}px`;
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", `0 0 ${SIZE} ${SIZE}`);
  svg.setAttribute("aria-hidden", "true");
  const marks = [];
  for (let i = 0; i < 60; i++) {
    const a = (i * Math.PI) / 30;
    const sin = Math.sin(a);
    const cos = Math.cos(a);
    const mark = document.createElementNS(SVG_NS, "line");
    mark.setAttribute("class", "wc-mark");
    mark.setAttribute("x1", fmt(C + R_IN * sin));
    mark.setAttribute("y1", fmt(C - R_IN * cos));
    mark.setAttribute("x2", fmt(C + R_OUT * sin));
    mark.setAttribute("y2", fmt(C - R_OUT * cos));
    svg.appendChild(mark);
    marks.push(mark);
  }
  const hand = (cls, len) => {
    const line = document.createElementNS(SVG_NS, "line");
    line.setAttribute("class", cls);
    line.setAttribute("x1", C);
    line.setAttribute("y1", C);
    line.setAttribute("x2", C);
    line.setAttribute("y2", C - len);
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
  let press = null;          // { id, x, y, left, top, minute, dragging }
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

  function setMarkClass(i, cls, on) {
    if (face && i >= 0) face.marks[i].classList.toggle(cls, on);
  }

  function setHover(minute) {
    if (minute === hovered) return;
    setMarkClass(hovered, "hover", false);
    hovered = minute;
    setMarkClass(hovered, "hover", true);
    face?.el.classList.toggle("over-mark", minute >= 0);
  }

  /** The minute mark a pointer is on, or -1 outside the band round the
   *  marks. */
  function minuteAt(e) {
    const r = face.el.getBoundingClientRect();
    const dx = e.clientX - (r.left + r.width / 2);
    const dy = e.clientY - (r.top + r.height / 2);
    const dist = Math.hypot(dx, dy);
    if (dist < R_IN - HIT_PAD || dist > R_OUT + HIT_PAD) return -1;
    const turn = Math.atan2(dx, -dy) / (2 * Math.PI); // 0 at twelve, clockwise
    return ((Math.round(turn * 60) % 60) + 60) % 60;
  }

  function onDown(e) {
    if (e.button !== 0 || press) return;
    e.preventDefault();
    const r = face.el.getBoundingClientRect();
    press = { id: e.pointerId, x: e.clientX, y: e.clientY, left: r.left, top: r.top, minute: minuteAt(e), dragging: false };
    face.el.setPointerCapture(e.pointerId);
  }

  function onMove(e) {
    if (!press) { setHover(minuteAt(e)); return; }
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
    } else if (e.type === "pointerup" && p.minute >= 0) {
      void setClockAlarm(state, p.minute === armedMinute(getClock(state)) ? null : nextMinuteMark(p.minute));
    }
  }

  function armedMinute(c) {
    return c.alarmAt == null ? -1 : new Date(c.alarmAt).getMinutes();
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
    setMarkClass(armed, "armed", false);
    armed = armedMinute(clock);
    setMarkClass(armed, "armed", true);
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
