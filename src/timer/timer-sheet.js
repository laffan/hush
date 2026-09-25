/**
 * Start timer — the sheet the command palette's "Start timer" opens.
 * Built like Courier (courier-sheet.js): a sheet of paper that slides up
 * from the bottom of the window, controls that read as text, Escape /
 * Cancel to dismiss.
 *
 * Top to bottom: the task, hours and minutes, how often to break, and a
 * timeline of the session laid out from the current time — each break
 * and the finish, re-laid on every change (and every few seconds, since
 * "now" moves). Start replaces any timer already there: there is only
 * ever one (timer-store.js).
 */

import {
  BREAK_CHOICES, lastValues, startTimer, breakTimes, formatClock,
} from "./timer-store.js";

const MINUTE = 60 * 1000;
/** The nearest two timeline labels may sit, as a share of its width. */
const LABEL_GAP = 0.14;

let open = null; // the live sheet's handle, or null

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function clampInt(raw, max) {
  const n = parseInt(String(raw).replace(/\D+/g, ""), 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(0, n)) : 0;
}

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
      <div class="timer-fields">
        <label class="timer-field">
          <input class="timer-num timer-hours" type="text" inputmode="numeric" maxlength="2" aria-label="Hours" />
          <span>hours</span>
        </label>
        <label class="timer-field">
          <input class="timer-num timer-minutes" type="text" inputmode="numeric" maxlength="2" aria-label="Minutes" />
          <span>minutes</span>
        </label>
      </div>
      <div class="timer-breaks">
        <span class="timer-caption">Break every</span>
        <div class="timer-seg" role="group" aria-label="Break every">
          ${BREAK_CHOICES.map((m) => `<button type="button" class="timer-break" data-min="${m}">${m ? m : "Never"}</button>`).join("")}
        </div>
        <span class="timer-caption timer-unit">min</span>
      </div>
      <div class="timer-timeline" aria-hidden="true">
        <div class="timer-track"><div class="timer-rule"></div></div>
        <div class="timer-labels"></div>
      </div>
      <div class="timer-summary"></div>
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

  let breakEvery = BREAK_CHOICES.includes(last.breakEvery) ? last.breakEvery : 0;
  hoursEl.value = String(clampInt(last.hours, 23));
  minutesEl.value = String(clampInt(last.minutes, 59));

  const values = () => ({
    task: taskEl.value,
    hours: clampInt(hoursEl.value, 23),
    minutes: clampInt(minutesEl.value, 59),
    breakEvery,
  });

  /** Lay the session out from the current time: a tick per break and a
   *  label wherever one fits without crowding its neighbours. */
  function renderTimeline() {
    for (const b of root.querySelectorAll(".timer-break")) {
      b.classList.toggle("active", Number(b.dataset.min) === breakEvery);
    }
    const { hours, minutes } = values();
    const durationMs = (hours * 60 + minutes) * MINUTE;
    startEl.disabled = durationMs <= 0;
    for (const t of trackEl.querySelectorAll(".timer-tick")) t.remove();
    if (durationMs <= 0) {
      labelsEl.innerHTML = "";
      summaryEl.textContent = "Set a length to begin.";
      root.classList.add("timer-empty");
      return;
    }
    root.classList.remove("timer-empty");
    const now = Date.now();
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
    const labels = [{ t: now, text: formatClock(now), kind: "now" }];
    for (const t of breaks) {
      const prev = labels[labels.length - 1];
      if (at(t) - at(prev.t) >= LABEL_GAP && 1 - at(t) >= LABEL_GAP) {
        labels.push({ t, text: formatClock(t), kind: "break" });
      }
    }
    labels.push({ t: end, text: formatClock(end), kind: "end" });
    labelsEl.innerHTML = labels.map((l) =>
      `<span class="timer-label timer-label-${l.kind}" style="left:${at(l.t) * 100}%">${esc(l.text)}</span>`).join("");

    const n = breaks.length;
    summaryEl.textContent = `${n ? `${n} break${n === 1 ? "" : "s"} · ` : ""}done at ${formatClock(end)}`;
  }

  async function start() {
    if (startEl.disabled) return;
    const v = values();
    close();
    await startTimer(state, v);
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

  // Hours / minutes: digits only; the arrow keys step an hour / five minutes.
  for (const [el, max] of [[hoursEl, 23], [minutesEl, 59]]) {
    el.addEventListener("input", () => {
      const digits = el.value.replace(/\D+/g, "");
      if (digits !== el.value) el.value = digits;
      renderTimeline();
    });
    el.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
      e.preventDefault();
      const step = el === minutesEl ? 5 : 1;
      const n = clampInt(el.value, max) + (e.key === "ArrowUp" ? step : -step);
      el.value = String(Math.min(max, Math.max(0, n)));
      renderTimeline();
    });
    el.addEventListener("blur", () => { el.value = String(clampInt(el.value, max)); });
    el.addEventListener("focus", () => el.select());
  }

  root.querySelector(".timer-seg").addEventListener("click", (e) => {
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
  renderTimeline();
  requestAnimationFrame(() => {
    root.classList.add("open");
    taskEl.focus();
  });
}
