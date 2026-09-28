/**
 * Focus timer — the box at the foot of the files sidebar, and the ring
 * that stands in for it while the sidebar is closed. Both exist for as
 * long as a timer does (running or finished), in every desk and every
 * window: the timer lives in settings (timer-store.js), so a sibling
 * window's Start, Delete or rename arrives through
 * `remote-settings-merged`.
 *
 * The box floats over the bottom of the file list, just above Add /
 * Settings: the task (double-click to reword it — the clock is left
 * alone), a thin progress bar under it, then time to go, time to the
 * next break and the finish time, in whole minutes.
 *
 * The ring sits in the window's lower-left corner while the sidebar is
 * hidden: the same progress as the bar, drawn round a 30 px circle with
 * an empty middle that shows the minutes to the next break (or to the
 * finish, once the breaks are used up) on hover. Clicking it opens the
 * sidebar — the way in on a screen with no hover.
 *
 * Breaks show as hash marks along both, and while one runs (BREAK_MS) a
 * second, thinner countdown appears: a bar under the sidebar's, a circle
 * inside the ring's. The ring can be dragged anywhere; it keeps the spot
 * (`settings.timer.ring`) and starts out equally far from the left and
 * bottom edges.
 *
 * When a break or the finish passes while the app is open, a toast says
 * so — and, for a timer started with chimes on, a tone as a break ends
 * and as the session does; ones that passed while it was closed stay
 * quiet.
 */

import {
  getTimer, timerStatus, formatMinutes, minutesLeft, formatClock, renameTimer, ALARM_WARNING_MS,
} from "./timer-store.js";
import { playChime } from "./timer-chimes.js";
import { installRingDrag } from "./timer-ring-drag.js";

/** Ring geometry: 30 px across with a 3 px stroke, so the stroke's centre
 *  line runs at radius 13.5. The break countdown is a thinner circle
 *  inside it. */
const RING_SIZE = 30;
const RING_STROKE = 3;
const RING_R = (RING_SIZE - RING_STROKE) / 2;
const BREAK_R = 8;
const C = RING_SIZE / 2;

/** A hash mark across the ring's stroke at `frac` of the way round. The
 *  svg is turned -90°, so angle 0 is twelve o'clock. */
function ringMark(frac) {
  const a = frac * 2 * Math.PI;
  const r0 = RING_R - RING_STROKE / 2 - 0.5, r1 = RING_R + RING_STROKE / 2 + 0.5;
  const p = (r) => `${(C + r * Math.cos(a)).toFixed(2)} ${(C + r * Math.sin(a)).toFixed(2)}`;
  return `<path class="timer-ring-mark" d="M${p(r0)}L${p(r1)}" />`;
}

/** A clock time with its AM / PM in a span of its own, which the
 *  narrowest sidebar drops (a 24-hour locale has none to drop). */
function clockHtml(ms) {
  const full = formatClock(ms);
  const short = formatClock(ms, { period: false });
  const period = full.startsWith(short) ? full.slice(short.length) : "";
  return period ? `${short}<span class="w-period">${period}</span>` : full;
}

export function mountTimerBox(slot, state, panelOverlay) {
  let timer = null;
  let key = null;          // identifies the timer the box is built for
  let tick = null;
  let seen = null;         // { breaksPassed, finished } last observed, for the toasts
  let box = null;
  let els = null;
  let ring = null;
  let editing = false;
  let marksKey = null;     // the break marks currently drawn
  let uninstallDrag = null;

  /** Hash marks where the breaks fall, on the bar and round the ring —
   *  redrawn only when the set changes. */
  function renderMarks(marks) {
    const k = marks.join(",");
    if (k === marksKey) return;
    marksKey = k;
    for (const m of els.progress.querySelectorAll(".sidebar-timer-mark")) m.remove();
    for (const f of marks) {
      const i = document.createElement("i");
      i.className = "sidebar-timer-mark";
      i.style.left = `${f * 100}%`;
      els.progress.appendChild(i);
    }
    els.ringMarks.innerHTML = marks.map(ringMark).join("");
  }

  function build() {
    slot.innerHTML = `
      <div class="sidebar-timer" role="timer" aria-live="off">
        <div class="sidebar-timer-task" title="Double-click to edit"></div>
        <div class="sidebar-timer-progress"><span></span></div>
        <div class="sidebar-timer-progress sidebar-timer-break-bar" hidden><span></span></div>
        <div class="sidebar-timer-line">
          <span class="sidebar-timer-countdown"></span>
          <span class="sidebar-timer-break"></span>
          <span class="sidebar-timer-end"></span>
        </div>
      </div>`;
    box = slot.firstElementChild;
    els = {
      task: box.querySelector(".sidebar-timer-task"),
      countdown: box.querySelector(".sidebar-timer-countdown"),
      brk: box.querySelector(".sidebar-timer-break"),
      end: box.querySelector(".sidebar-timer-end"),
      progress: box.querySelector(".sidebar-timer-progress"),
      bar: box.querySelector(".sidebar-timer-progress span"),
      breakBar: box.querySelector(".sidebar-timer-break-bar"),
    };
    els.task.addEventListener("dblclick", startEditing);

    ring = document.createElement("button");
    ring.type = "button";
    ring.className = "timer-ring";
    ring.innerHTML = `
      <svg viewBox="0 0 ${RING_SIZE} ${RING_SIZE}" aria-hidden="true">
        <circle class="timer-ring-track" cx="${RING_SIZE / 2}" cy="${RING_SIZE / 2}" r="${RING_R}" />
        <circle class="timer-ring-fill" cx="${RING_SIZE / 2}" cy="${RING_SIZE / 2}" r="${RING_R}" pathLength="100" />
        <g class="timer-ring-marks"></g>
        <circle class="timer-ring-break" cx="${C}" cy="${C}" r="${BREAK_R}" pathLength="100" />
      </svg>
      <span class="timer-ring-label"></span>`;
    // A press that travels is a drag; one that doesn't opens the sidebar.
    uninstallDrag = installRingDrag(ring, state, () => state.emit("toggle-left-panel"));
    document.body.appendChild(ring);
    els.ringFill = ring.querySelector(".timer-ring-fill");
    els.ringLabel = ring.querySelector(".timer-ring-label");
    els.ringMarks = ring.querySelector(".timer-ring-marks");
    els.ringBreak = ring.querySelector(".timer-ring-break");
    marksKey = null;
    syncRing();
  }

  function teardown() {
    clearInterval(tick);
    tick = null;
    slot.innerHTML = "";
    ring?.remove();
    uninstallDrag?.();
    box = els = ring = uninstallDrag = null;
    editing = false;
    panelOverlay.classList.remove("has-timer");
  }

  /** The ring shows only while the sidebar is closed. */
  function syncRing() {
    if (!ring) return;
    ring.classList.toggle("visible", panelOverlay.classList.contains("hidden"));
  }
  new MutationObserver(syncRing).observe(panelOverlay, { attributes: true, attributeFilter: ["class"] });

  // Double-click the task to reword it. Enter or leaving the field keeps
  // the new wording, Escape puts the old one back; the timer runs on
  // untouched either way.
  function startEditing() {
    if (editing || !timer) return;
    editing = true;
    const input = document.createElement("input");
    input.type = "text";
    input.className = "sidebar-timer-task-input";
    input.value = timer.task || "";
    input.placeholder = "What are you working on?";
    input.setAttribute("aria-label", "Task");
    input.spellcheck = false;
    els.task.replaceWith(input);
    input.focus();
    input.select();

    let done = false;
    const finish = (commit) => {
      if (done) return;
      done = true;
      editing = false;
      const next = input.value.trim();
      input.replaceWith(els?.task || document.createTextNode(""));
      if (commit && timer && next !== (timer.task || "")) void renameTimer(state, next);
      render();
    };
    // Keys stay in the field: the window-level shortcut fallback and the
    // sidebar's typing-fade never hear them.
    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") { e.preventDefault(); finish(true); }
      else if (e.key === "Escape") { e.preventDefault(); finish(false); }
    });
    input.addEventListener("blur", () => finish(true));
  }

  async function toast(message) {
    const { showImportToast } = await import("../editor/import-toast.js");
    showImportToast(message, "info");
  }

  function render() {
    if (!timer || !els) return;
    const now = Date.now();
    const st = timerStatus(timer, now);
    if (!editing) els.task.textContent = timer.task || "Focus";
    box.classList.toggle("finished", st.finished);
    els.bar.style.width = `${st.progress * 100}%`;
    els.ringFill.style.strokeDashoffset = String(100 - st.progress * 100);
    ring.classList.toggle("finished", st.finished);
    renderMarks(st.breakMarks);
    // The break's own countdown: what's left of it, emptying as it runs.
    const brk = st.finished ? null : st.onBreak;
    els.breakBar.hidden = !brk;
    ring.classList.toggle("on-break", !!brk);
    if (brk) {
      els.breakBar.firstElementChild.style.width = `${(1 - brk.progress) * 100}%`;
      els.ringBreak.style.strokeDashoffset = String(brk.progress * 100);
    }

    // An alarm's last ten minutes: the minutes to go in red, and the ring
    // shows them without being hovered.
    const alarmSoon = timer.mode === "alarm" && !st.finished && st.remaining <= ALARM_WARNING_MS;
    box.classList.toggle("alarm-soon", alarmSoon);
    ring.classList.toggle("alarm-soon", alarmSoon);

    if (st.finished) {
      box.classList.remove("break-now");
      els.countdown.textContent = "Done";
      els.brk.textContent = "";
      els.end.innerHTML = `<span class="w-ends">ended </span>${clockHtml(st.end)}`;
      els.ringLabel.textContent = "✓";
      ring.setAttribute("aria-label", "Timer done");
    } else {
      els.countdown.innerHTML = `${formatMinutes(st.remaining)}<span class="w-togo"> to go</span>`;
      box.classList.toggle("break-now", !!brk);
      els.brk.innerHTML = brk ? `break<span class="w-in"> ·</span> ${formatMinutes(brk.remaining)}`
        : st.untilBreak != null ? `break<span class="w-in"> in</span> ${formatMinutes(st.untilBreak)}` : "";
      els.end.innerHTML = `<span class="w-ends">ends </span>${clockHtml(st.end)}`;
      // Minutes to the next break, or to the finish once none are left.
      // On a break, the minutes left of it.
      const toNext = alarmSoon ? st.remaining : brk ? brk.remaining : (st.untilBreak ?? st.remaining);
      const mins = minutesLeft(toNext);
      els.ringLabel.textContent = mins > 99 ? `${Math.floor(mins / 60)}h` : String(mins);
      ring.setAttribute("aria-label", alarmSoon ? `${mins} min to go`
        : brk ? `${mins} min of break left`
        : st.untilBreak != null ? `${mins} min to the next break` : `${mins} min to go`);
    }
    ring.title = ring.getAttribute("aria-label");

    if (seen) {
      if (st.finished && !seen.finished) {
        void toast(`${timer.mode === "alarm" ? "Alarm" : "Timer done"}${timer.task ? ` — ${timer.task}` : ""}`);
        if (timer.chimes) playChime("session");
      }
      else {
        if (st.breaksPassed > seen.breaksPassed) void toast("Time for a break");
        if (st.breaksDone > seen.breaksDone && timer.chimes) playChime("break");
      }
    }
    seen = { breaksPassed: st.breaksPassed, breaksDone: st.breaksDone, finished: st.finished };
    if (st.finished && tick) { clearInterval(tick); tick = null; }
  }

  function sync() {
    const next = getTimer(state);
    const nextKey = next ? JSON.stringify(next) : null;
    if (nextKey === key) return;
    // A reworded task is the same timer: keep the toast bookkeeping.
    const sameClock = next && timer
      && next.startedAt === timer.startedAt && next.durationMs === timer.durationMs
      && next.breakEveryMs === timer.breakEveryMs;
    key = nextKey;
    timer = next;
    if (!sameClock) seen = null;
    if (!timer) { teardown(); return; }
    if (!box) build();
    render();
    panelOverlay.classList.add("has-timer");
    clearInterval(tick);
    tick = timerStatus(timer).finished ? null : setInterval(render, 1000);
  }

  // Timers in background windows are throttled; catch up the moment the
  // window is looked at again.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") render();
  });
  state.on("settings-changed", sync);
  state.on("remote-settings-merged", sync);
  sync();
}
