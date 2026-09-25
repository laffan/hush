/**
 * Start timer — the sheet the command palette's "Start timer" opens.
 * Built like Courier (courier-sheet.js): a sheet of paper that slides up
 * from the bottom of the window, controls that read as text, Escape /
 * Cancel to dismiss.
 *
 * Top to bottom, every row centred: the task; Timer / Alarm; either
 * hours and minutes (a timer's length) or a clock time (an alarm's — the
 * next time the clock reads it, today or tomorrow); a timeline of the
 * session laid out from the current time — each break and the finish,
 * re-laid on every change (and every few seconds, since "now" moves);
 * and under it, how often to break. Start replaces any timer already there: there is only ever
 * one (timer-store.js).
 */

import {
  BREAK_CHOICES, lastValues, startTimer, breakTimes, formatClock, nextOccurrence, uses12HourClock,
} from "./timer-store.js";

const MINUTE = 60 * 1000;
/** The nearest two timeline labels may sit, as a share of its width. */
const LABEL_GAP = 0.14;

let open = null; // the live sheet's handle, or null

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function clampInt(raw, max, min = 0) {
  const n = parseInt(String(raw).replace(/\D+/g, ""), 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : min;
}

const MODES = [{ id: "timer", label: "Timer" }, { id: "alarm", label: "Alarm" }];

export function openTimerSheet(state) {
  if (open) return;
  const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const last = lastValues(state);

  const root = document.createElement("div");
  root.className = "timer-root";
  root.innerHTML = `
    <div class="timer-backdrop"></div>
    <div class="timer-sheet" role="dialog" aria-modal="true" aria-label="Start timer">
      <input class="timer-task" type="text" placeholder="What are you working on?" aria-label="Task"
        autocomplete="off" spellcheck="false" />
      <div class="timer-seg timer-modes" role="group" aria-label="Timer or alarm">
        ${MODES.map((m) => `<button type="button" class="timer-mode" data-mode="${m.id}">${m.label}</button>`).join("")}
      </div>
      <div class="timer-fields timer-fields-length">
        <label class="timer-field">
          <input class="timer-num timer-hours" type="text" inputmode="numeric" maxlength="2" aria-label="Hours" />
          <span>hours</span>
        </label>
        <label class="timer-field">
          <input class="timer-num timer-minutes" type="text" inputmode="numeric" maxlength="2" aria-label="Minutes" />
          <span>minutes</span>
        </label>
      </div>
      <div class="timer-fields timer-fields-clock" hidden>
        <div class="timer-field timer-clock">
          <input class="timer-num timer-clock-hour" type="text" inputmode="numeric" maxlength="2" aria-label="Alarm hour" />
          <span class="timer-colon">:</span>
          <input class="timer-num timer-clock-minute" type="text" inputmode="numeric" maxlength="2" aria-label="Alarm minute" />
        </div>
        <div class="timer-seg timer-periods" role="group" aria-label="AM or PM">
          <button type="button" class="timer-period" data-period="am">AM</button>
          <button type="button" class="timer-period" data-period="pm">PM</button>
        </div>
      </div>
      <div class="timer-timeline" aria-hidden="true">
        <div class="timer-track"><div class="timer-rule"></div></div>
        <div class="timer-labels"></div>
      </div>
      <div class="timer-summary"></div>
      <div class="timer-breaks">
        <span class="timer-caption">Break every</span>
        <div class="timer-seg" role="group" aria-label="Break every">
          ${BREAK_CHOICES.map((m) => `<button type="button" class="timer-break" data-min="${m}">${m ? m : "Never"}</button>`).join("")}
        </div>
        <span class="timer-caption timer-unit">min</span>
      </div>
      <div class="timer-actions">
        <button type="button" class="timer-cancel">Cancel</button>
        <button type="button" class="timer-start">Start</button>
      </div>
    </div>`;
  document.body.appendChild(root);

  const sheet = root.querySelector(".timer-sheet");
  const taskEl = root.querySelector(".timer-task");
  const hoursEl = root.querySelector(".timer-hours");
  const minutesEl = root.querySelector(".timer-minutes");
  const trackEl = root.querySelector(".timer-track");
  const labelsEl = root.querySelector(".timer-labels");
  const summaryEl = root.querySelector(".timer-summary");
  const startEl = root.querySelector(".timer-start");
  const lengthEl = root.querySelector(".timer-fields-length");
  const clockEl = root.querySelector(".timer-fields-clock");
  const clockHourEl = root.querySelector(".timer-clock-hour");
  const clockMinuteEl = root.querySelector(".timer-clock-minute");
  const periodsEl = root.querySelector(".timer-periods");

  let breakEvery = BREAK_CHOICES.includes(last.breakEvery) ? last.breakEvery : 0;
  let mode = last.mode === "alarm" ? "alarm" : "timer";
  hoursEl.value = String(clampInt(last.hours, 23));
  minutesEl.value = String(clampInt(last.minutes, 59));

  // The alarm clock follows the locale: 1-12 with AM / PM, or 0-23. It
  // opens on the last alarm set, or on the next full hour.
  const twelve = uses12HourClock();
  periodsEl.hidden = !twelve;
  const seedHour = Number.isInteger(last.alarmHour) ? last.alarmHour : (new Date().getHours() + 1) % 24;
  let pm = seedHour >= 12;
  clockHourEl.value = String(twelve ? (seedHour % 12 || 12) : seedHour);
  clockMinuteEl.value = String(clampInt(last.alarmMinute, 59)).padStart(2, "0");
  const hourMax = twelve ? 12 : 23;
  const hourMin = twelve ? 1 : 0;

  /** The alarm's hour on a 24-hour clock. */
  function alarmHour24() {
    const h = clampInt(clockHourEl.value, hourMax, hourMin);
    return twelve ? (h % 12) + (pm ? 12 : 0) : h;
  }

  /** The session's length from `now`: hours and minutes for a timer, the
   *  time left until the clock reads the alarm for an alarm. */
  function durationFrom(now) {
    if (mode === "alarm") return nextOccurrence(alarmHour24(), clampInt(clockMinuteEl.value, 59), now) - now;
    return (clampInt(hoursEl.value, 23) * 60 + clampInt(minutesEl.value, 59)) * MINUTE;
  }

  function applyMode() {
    for (const b of root.querySelectorAll(".timer-mode")) b.classList.toggle("active", b.dataset.mode === mode);
    lengthEl.hidden = mode !== "timer";
    clockEl.hidden = mode !== "alarm";
    for (const b of root.querySelectorAll(".timer-period")) b.classList.toggle("active", (b.dataset.period === "pm") === pm);
    renderTimeline();
  }

  /** Lay the session out from the current time: a tick per break and a
   *  label wherever one fits without crowding its neighbours. */
  function renderTimeline() {
    for (const b of root.querySelectorAll(".timer-break")) {
      b.classList.toggle("active", Number(b.dataset.min) === breakEvery);
    }
    const now = Date.now();
    const durationMs = durationFrom(now);
    startEl.disabled = durationMs <= 0;
    for (const t of trackEl.querySelectorAll(".timer-tick")) t.remove();
    if (durationMs <= 0) {
      labelsEl.innerHTML = "";
      summaryEl.textContent = "Set a length to begin.";
      root.classList.add("timer-empty");
      return;
    }
    root.classList.remove("timer-empty");
    const end = now + durationMs;
    const breaks = breakTimes(now, durationMs, breakEvery * MINUTE);
    const at = (t) => (t - now) / durationMs;

    const ticks = [
      ...breaks.map((t) => ({ t, kind: "break" })),
      { t: end, kind: "end" },
    ];
    for (const { t, kind } of ticks) {
      const el = document.createElement("span");
      el.className = `timer-tick timer-tick-${kind}`;
      el.style.left = `${at(t) * 100}%`;
      trackEl.appendChild(el);
    }

    // Now and the finish are always labelled; breaks fill in between
    // where there is room.
    const labels = [{ t: now, text: formatClock(now, { period: false }), kind: "now" }];
    for (const t of breaks) {
      const prev = labels[labels.length - 1];
      if (at(t) - at(prev.t) >= LABEL_GAP && 1 - at(t) >= LABEL_GAP) {
        labels.push({ t, text: formatClock(t, { period: false }), kind: "break" });
      }
    }
    labels.push({ t: end, text: formatClock(end, { period: false }), kind: "end" });
    labelsEl.innerHTML = labels.map((l) =>
      `<span class="timer-label timer-label-${l.kind}" style="left:${at(l.t) * 100}%">${esc(l.text)}</span>`).join("");

    const n = breaks.length;
    const tomorrow = new Date(end).toDateString() !== new Date(now).toDateString();
    summaryEl.textContent = `${n ? `${n} break${n === 1 ? "" : "s"} · ` : ""}done at ${formatClock(end)}${tomorrow ? " tomorrow" : ""}`;
  }

  async function start() {
    if (startEl.disabled) return;
    const now = Date.now();
    const durationMs = durationFrom(now);
    if (durationMs <= 0) return;
    const opts = {
      task: taskEl.value,
      mode,
      durationMs,
      breakEvery,
      last: mode === "alarm"
        ? { alarmHour: alarmHour24(), alarmMinute: clampInt(clockMinuteEl.value, 59) }
        : { hours: clampInt(hoursEl.value, 23), minutes: clampInt(minutesEl.value, 59) },
    };
    close();
    await startTimer(state, opts, now);
  }

  function close() {
    if (!open) return;
    open = null;
    clearInterval(clock);
    window.removeEventListener("keydown", onWindowKey, true);
    root.classList.remove("open");
    let done = false;
    const finish = () => { if (!done) { done = true; root.remove(); } };
    sheet.addEventListener("transitionend", finish, { once: true });
    setTimeout(finish, 320);
    if (returnFocus && returnFocus.isConnected) {
      try { returnFocus.focus({ preventScroll: true }); } catch (_) {}
    }
  }

  // Escape at window capture — ahead of Zen's document-capture Escape,
  // as Courier does.
  function onWindowKey(e) {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopImmediatePropagation();
    close();
  }
  window.addEventListener("keydown", onWindowKey, true);

  // Keys stop at the sheet so the window-level shortcut fallback and the
  // sidebar's typing-fade never hear them.
  sheet.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter" && !e.shiftKey && !e.altKey && e.target instanceof HTMLInputElement) {
      e.preventDefault();
      void start();
    }
  });

  // Number fields: digits only; the arrow keys step an hour / five
  // minutes. The alarm's minute keeps its leading zero.
  const fields = [
    { el: hoursEl, min: 0, max: 23, step: 1 },
    { el: minutesEl, min: 0, max: 59, step: 5 },
    { el: clockHourEl, min: hourMin, max: hourMax, step: 1 },
    { el: clockMinuteEl, min: 0, max: 59, step: 5, pad: true },
  ];
  for (const { el, min, max, step, pad } of fields) {
    const tidy = (n) => (pad ? String(n).padStart(2, "0") : String(n));
    el.addEventListener("input", () => {
      const digits = el.value.replace(/\D+/g, "");
      if (digits !== el.value) el.value = digits;
      renderTimeline();
    });
    el.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
      e.preventDefault();
      const n = clampInt(el.value, max, min) + (e.key === "ArrowUp" ? step : -step);
      el.value = tidy(Math.min(max, Math.max(min, n)));
      renderTimeline();
    });
    el.addEventListener("blur", () => { el.value = tidy(clampInt(el.value, max, min)); });
    el.addEventListener("focus", () => el.select());
  }

  root.querySelector(".timer-modes").addEventListener("click", (e) => {
    const b = e.target instanceof Element ? e.target.closest(".timer-mode") : null;
    if (!b || b.dataset.mode === mode) return;
    mode = b.dataset.mode;
    applyMode();
    (mode === "alarm" ? clockHourEl : hoursEl).focus();
  });

  periodsEl.addEventListener("click", (e) => {
    const b = e.target instanceof Element ? e.target.closest(".timer-period") : null;
    if (!b) return;
    pm = b.dataset.period === "pm";
    applyMode();
  });

  root.querySelector(".timer-breaks .timer-seg").addEventListener("click", (e) => {
    const b = e.target instanceof Element ? e.target.closest(".timer-break") : null;
    if (!b) return;
    breakEvery = Number(b.dataset.min);
    renderTimeline();
  });

  root.querySelector(".timer-backdrop").addEventListener("pointerdown", (e) => { e.preventDefault(); close(); });
  root.querySelector(".timer-cancel").addEventListener("click", close);
  startEl.addEventListener("click", () => void start());

  // "Now" moves while the sheet is up; keep the timeline honest.
  const clock = setInterval(renderTimeline, 15000);

  open = { close };
  applyMode();
  requestAnimationFrame(() => {
    root.classList.add("open");
    taskEl.focus();
  });
}
