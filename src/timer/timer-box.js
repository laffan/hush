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
 * When a break or the finish passes while the app is open, a toast says
 * so; ones that passed while it was closed stay quiet.
 */

import {
  getTimer, timerStatus, formatMinutes, minutesLeft, formatClock, renameTimer, ALARM_WARNING_MS,
} from "./timer-store.js";

/** How long after a break the box says "break now" instead of counting
 *  to the next one. */
const BREAK_NOW_MS = 60 * 1000;

/** Ring geometry: 30 px across with a 3 px stroke, so the stroke's centre
 *  line runs at radius 13.5. */
const RING_SIZE = 30;
const RING_STROKE = 3;
const RING_R = (RING_SIZE - RING_STROKE) / 2;

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

  function build() {
    slot.innerHTML = `
      <div class="sidebar-timer" role="timer" aria-live="off">
        <div class="sidebar-timer-task" title="Double-click to edit"></div>
        <div class="sidebar-timer-progress"><span></span></div>
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
      bar: box.querySelector(".sidebar-timer-progress span"),
    };
    els.task.addEventListener("dblclick", startEditing);

    ring = document.createElement("button");
    ring.type = "button";
    ring.className = "timer-ring";
    ring.innerHTML = `
      <svg viewBox="0 0 ${RING_SIZE} ${RING_SIZE}" aria-hidden="true">
        <circle class="timer-ring-track" cx="${RING_SIZE / 2}" cy="${RING_SIZE / 2}" r="${RING_R}" />
        <circle class="timer-ring-fill" cx="${RING_SIZE / 2}" cy="${RING_SIZE / 2}" r="${RING_R}" pathLength="100" />
      </svg>
      <span class="timer-ring-label"></span>`;
    ring.addEventListener("click", () => state.emit("toggle-left-panel"));
    document.body.appendChild(ring);
    els.ringFill = ring.querySelector(".timer-ring-fill");
    els.ringLabel = ring.querySelector(".timer-ring-label");
    syncRing();
  }

  function teardown() {
    clearInterval(tick);
    tick = null;
    slot.innerHTML = "";
    ring?.remove();
    box = els = ring = null;
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
      const lastBreak = st.breaksPassed
        ? timer.startedAt + st.breaksPassed * timer.breakEveryMs : null;
      const breakNow = lastBreak != null && now - lastBreak < BREAK_NOW_MS;
      box.classList.toggle("break-now", breakNow);
      els.brk.innerHTML = breakNow ? "break now"
        : st.untilBreak != null ? `break<span class="w-in"> in</span> ${formatMinutes(st.untilBreak)}` : "";
      els.end.innerHTML = `<span class="w-ends">ends </span>${clockHtml(st.end)}`;
      // Minutes to the next break, or to the finish once none are left.
      const toNext = alarmSoon ? st.remaining : (st.untilBreak ?? st.remaining);
      const mins = minutesLeft(toNext);
      els.ringLabel.textContent = mins > 99 ? `${Math.floor(mins / 60)}h` : String(mins);
      ring.setAttribute("aria-label", !alarmSoon && st.untilBreak != null
        ? `${mins} min to the next break` : `${mins} min to go`);
    }
    ring.title = ring.getAttribute("aria-label");

    if (seen) {
      if (st.finished && !seen.finished) {
        void toast(`${timer.mode === "alarm" ? "Alarm" : "Timer done"}${timer.task ? ` — ${timer.task}` : ""}`);
      }
      else if (st.breaksPassed > seen.breaksPassed) void toast("Time for a break");
    }
    seen = { breaksPassed: st.breaksPassed, finished: st.finished };
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
