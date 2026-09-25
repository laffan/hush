/**
 * Focus timer — the box at the foot of the files sidebar. It floats over
 * the bottom of the file list, just above Add / Settings, for as long as
 * a timer exists (running or finished), in every desk and every window:
 * the timer lives in settings (timer-store.js), so a sibling window's
 * Start or Delete arrives through `remote-settings-merged`.
 *
 * Two lines: the task, then the countdown, the time to the next break
 * and the finish time. A hairline along the bottom fills as the session
 * runs. When a break or the finish passes while the app is open, a toast
 * says so; ones that passed while it was closed stay quiet.
 */

import { getTimer, timerStatus, formatCountdown, formatClock } from "./timer-store.js";

/** How long after a break the box says "break now" instead of counting
 *  to the next one. */
const BREAK_NOW_MS = 60 * 1000;

export function mountTimerBox(slot, state, panelOverlay) {
  let timer = null;
  let key = null;          // identifies the timer the box is built for
  let tick = null;
  let seen = null;         // { breaksPassed, finished } last observed, for the toasts
  let box = null;
  let els = null;

  function build() {
    slot.innerHTML = `
      <div class="sidebar-timer" role="timer" aria-live="off">
        <div class="sidebar-timer-task"></div>
        <div class="sidebar-timer-line">
          <span class="sidebar-timer-countdown"></span>
          <span class="sidebar-timer-break"></span>
          <span class="sidebar-timer-end"></span>
        </div>
        <div class="sidebar-timer-progress"><span></span></div>
      </div>`;
    box = slot.firstElementChild;
    els = {
      task: box.querySelector(".sidebar-timer-task"),
      countdown: box.querySelector(".sidebar-timer-countdown"),
      brk: box.querySelector(".sidebar-timer-break"),
      end: box.querySelector(".sidebar-timer-end"),
      bar: box.querySelector(".sidebar-timer-progress span"),
    };
  }

  function teardown() {
    clearInterval(tick);
    tick = null;
    slot.innerHTML = "";
    box = els = null;
    panelOverlay.classList.remove("has-timer");
  }

  async function toast(message) {
    const { showImportToast } = await import("../editor/import-toast.js");
    showImportToast(message, "info");
  }

  function render() {
    if (!timer || !els) return;
    const now = Date.now();
    const st = timerStatus(timer, now);
    const task = timer.task || "Focus";
    els.task.textContent = task;
    els.task.title = task;
    box.classList.toggle("finished", st.finished);
    els.bar.style.width = `${st.progress * 100}%`;

    if (st.finished) {
      box.classList.remove("break-now");
      els.countdown.textContent = "Done";
      els.brk.textContent = "";
      els.end.textContent = `ended ${formatClock(st.end)}`;
    } else {
      els.countdown.textContent = formatCountdown(st.remaining);
      const lastBreak = st.breaksPassed
        ? timer.startedAt + st.breaksPassed * timer.breakEveryMs : null;
      const breakNow = lastBreak != null && now - lastBreak < BREAK_NOW_MS;
      box.classList.toggle("break-now", breakNow);
      els.brk.textContent = breakNow ? "break now"
        : st.untilBreak != null ? `break in ${formatCountdown(st.untilBreak)}` : "";
      els.end.textContent = `ends ${formatClock(st.end)}`;
    }

    if (seen) {
      if (st.finished && !seen.finished) void toast(`Timer done${timer.task ? ` — ${timer.task}` : ""}`);
      else if (st.breaksPassed > seen.breaksPassed) void toast("Time for a break");
    }
    seen = { breaksPassed: st.breaksPassed, finished: st.finished };
    if (st.finished && tick) { clearInterval(tick); tick = null; }
  }

  function sync() {
    const next = getTimer(state);
    const nextKey = next ? JSON.stringify(next) : null;
    if (nextKey === key) return;
    key = nextKey;
    timer = next;
    seen = null;
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
