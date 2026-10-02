/**
 * Progress — the modal the palette's "Show Project Progress" and "Show
 * Desk Progress" open. One design for both; only the scope differs
 * (progress-data.js).
 *
 * A month at a time, in two views on tabs: a calendar, each day's slot
 * holding the words added that day (its tint deepening with the
 * number), and a bar chart of the same month. Either way a day can be
 * picked, and the panel under the view breaks that day down by file and,
 * inside each file, by section. Today is picked to begin with.
 *
 * Months are fetched as they are shown and kept for as long as the modal
 * is open; the counts come from version history (see
 * src-tauri/src/progress.rs), so opening the modal writes nothing.
 */

import { resolveScope, loadMonthProgress } from "./progress-data.js";

let open = null; // the live modal's handle

const VIEWS = [{ id: "calendar", label: "Calendar" }, { id: "graph", label: "Graph" }];

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

const fmtNum = (n) => new Intl.NumberFormat().format(n);
const words = (n) => `${fmtNum(n)} word${n === 1 ? "" : "s"}`;

/** First day of the week for the user's locale: 0 Sunday … 6 Saturday. */
function firstWeekday() {
  try {
    const loc = new Intl.Locale(navigator.language || "en-US");
    const info = loc.getWeekInfo?.() || loc.weekInfo;
    if (info?.firstDay) return info.firstDay % 7;
  } catch (_) {}
  return /^en-(US|CA)|^ja|^zh-TW|^ko/.test(navigator.language || "en-US") ? 0 : 1;
}

/** "Show Project Progress" / "Show Desk Progress". */
export function openProgressModal(state, kind) {
  open?.close();
  const scope = resolveScope(state, kind);
  if (!scope) return;
  const names = new Map(scope.files.map((f) => [f.id, f.name]));

  const now = new Date();
  let year = now.getFullYear();
  let month = now.getMonth();
  let view = "calendar";
  let picked = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const months = new Map(); // "y-m" → Promise<days>
  let current = null;       // the shown month's days, once loaded

  const root = document.createElement("div");
  root.className = "progress-overlay";
  root.innerHTML = `
    <div class="progress-modal" role="dialog" aria-modal="true" aria-label="${esc(kind === "project" ? "Project progress" : "Desk progress")}">
      <div class="progress-head">
        <div class="progress-title">
          <span class="progress-kind">${kind === "project" ? "Project" : "Desk"} progress</span>
          <span class="progress-scope">${esc(scope.title)}</span>
        </div>
        <div class="progress-tabs" role="tablist">
          ${VIEWS.map((v) => `<button type="button" class="progress-tab" role="tab" data-view="${v.id}">${v.label}</button>`).join("")}
        </div>
        <button type="button" class="progress-close" aria-label="Close">×</button>
      </div>
      <div class="progress-nav">
        <button type="button" class="progress-step" data-step="-1" aria-label="Previous month">‹</button>
        <span class="progress-month"></span>
        <button type="button" class="progress-step" data-step="1" aria-label="Next month">›</button>
        <span class="progress-month-total"></span>
      </div>
      <div class="progress-view"></div>
      <div class="progress-day"></div>
    </div>`;
  document.body.appendChild(root);

  const viewEl = root.querySelector(".progress-view");
  const dayEl = root.querySelector(".progress-day");
  const monthEl = root.querySelector(".progress-month");
  const totalEl = root.querySelector(".progress-month-total");
  const nextEl = root.querySelector('[data-step="1"]');

  function monthDays(y, m) {
    const k = `${y}-${m}`;
    if (!months.has(k)) months.set(k, loadMonthProgress(scope, y, m).catch((e) => ({ error: e })));
    return months.get(k);
  }

  async function show() {
    const [y, m] = [year, month];
    monthEl.textContent = new Date(y, m, 1).toLocaleDateString(undefined, { month: "long", year: "numeric" });
    nextEl.disabled = new Date(y, m + 1, 1) > now;
    for (const b of root.querySelectorAll(".progress-tab")) {
      b.classList.toggle("active", b.dataset.view === view);
      b.setAttribute("aria-selected", String(b.dataset.view === view));
    }
    current = null;
    totalEl.textContent = "";
    viewEl.innerHTML = `<div class="progress-status">Reading version history…</div>`;
    dayEl.innerHTML = "";
    const days = await monthDays(y, m);
    if (!open || y !== year || m !== month) return; // moved on meanwhile
    if (days?.error) {
      viewEl.innerHTML = `<div class="progress-status">Couldn't read the history: ${esc(String(days.error?.message || days.error))}</div>`;
      return;
    }
    current = days;
    const total = days.reduce((n, d) => n + d.total, 0);
    totalEl.textContent = total ? `${words(total)} this month` : "";
    if (view === "calendar") renderCalendar(days); else renderGraph(days);
    renderDay();
  }

  const isFuture = (dayStart) => dayStart > now.getTime();
  const isToday = (dayStart) => dayStart === new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();

  function renderCalendar(days) {
    const max = Math.max(1, ...days.map((d) => d.total));
    const first = firstWeekday();
    const lead = (new Date(year, month, 1).getDay() - first + 7) % 7;
    const weekdays = Array.from({ length: 7 }, (_, i) =>
      new Date(2024, 0, 7 + ((first + i) % 7)).toLocaleDateString(undefined, { weekday: "short" }));
    const cells = [];
    for (let i = 0; i < lead; i++) cells.push(`<div class="progress-cell progress-cell-pad"></div>`);
    days.forEach((d, i) => {
      // Tint by magnitude: one hue, deeper for more, on a square-root
      // scale so a modest day still reads beside a big one.
      const share = d.total ? Math.sqrt(d.total / max) : 0;
      const cls = ["progress-cell",
        isToday(d.dayStart) && "today",
        isFuture(d.dayStart) && "future",
        d.dayStart === picked && "picked",
        d.total && "has-words"].filter(Boolean).join(" ");
      cells.push(`<button type="button" class="${cls}" data-day="${d.dayStart}" style="--share:${share.toFixed(3)}"
          aria-label="${esc(new Date(d.dayStart).toLocaleDateString(undefined, { month: "long", day: "numeric" }))}: ${esc(words(d.total))}">
        <span class="progress-cell-date">${i + 1}</span>
        <span class="progress-cell-count">${d.total ? fmtNum(d.total) : ""}</span>
      </button>`);
    });
    viewEl.innerHTML = `
      <div class="progress-calendar">
        ${weekdays.map((w) => `<div class="progress-weekday">${esc(w)}</div>`).join("")}
        ${cells.join("")}
      </div>`;
  }

  /** The month as bars: one per day, from a zero baseline, a light grid
   *  at round numbers, every seventh day labelled. One series, so no
   *  legend — the heading says what it is. */
  function renderGraph(days) {
    const W = 640, H = 220, padL = 44, padR = 8, padT = 10, padB = 24;
    const plotW = W - padL - padR, plotH = H - padT - padB;
    const max = Math.max(...days.map((d) => d.total));
    const step = niceStep(max || 1);
    const top = Math.max(step, Math.ceil((max || 1) / step) * step);
    const slot = plotW / days.length;
    const barW = Math.max(2, slot - 2); // 2px gap between neighbours
    const y = (v) => padT + plotH - (v / top) * plotH;
    const grid = [];
    for (let v = 0; v <= top; v += step) {
      grid.push(`<line class="progress-grid${v === 0 ? " base" : ""}" x1="${padL}" x2="${W - padR}" y1="${y(v)}" y2="${y(v)}" />`
        + `<text class="progress-axis" x="${padL - 6}" y="${y(v) + 3.5}" text-anchor="end">${fmtNum(v)}</text>`);
    }
    const bars = days.map((d, i) => {
      const x = padL + i * slot + (slot - barW) / 2;
      const h = Math.max(0, plotH - (y(d.total) - padT));
      const r = Math.min(4, barW / 2, h);
      const yTop = padT + plotH - h;
      const cls = ["progress-bar", d.dayStart === picked && "picked", isToday(d.dayStart) && "today"].filter(Boolean).join(" ");
      const label = `${new Date(d.dayStart).toLocaleDateString(undefined, { month: "short", day: "numeric" })} · ${words(d.total)}`;
      // Rounded at the data end only; square on the baseline.
      const path = h > 0
        ? `M${x},${padT + plotH}V${yTop + r}Q${x},${yTop} ${x + r},${yTop}H${x + barW - r}Q${x + barW},${yTop} ${x + barW},${yTop + r}V${padT + plotH}Z`
        : "";
      // The hit target is the whole column, taller and wider than the bar.
      return `<g class="progress-col" data-day="${d.dayStart}" data-label="${esc(label)}">
          <rect class="progress-hit" x="${padL + i * slot}" y="${padT}" width="${slot}" height="${plotH}" />
          ${path ? `<path class="${cls}" d="${path}" />` : ""}
        </g>`;
    }).join("");
    const ticks = days.map((d, i) => (i % 7 === 0 || (i === days.length - 1 && i % 7 >= 3))
      ? `<text class="progress-axis" x="${padL + i * slot + slot / 2}" y="${H - 6}" text-anchor="middle">${i + 1}</text>` : "").join("");
    viewEl.innerHTML = `
      <div class="progress-graph">
        <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Words added per day, ${esc(monthEl.textContent)}">
          ${grid.join("")}${bars}${ticks}
        </svg>
        <div class="progress-tip" hidden></div>
      </div>`;
    const tip = viewEl.querySelector(".progress-tip");
    const svg = viewEl.querySelector("svg");
    svg.addEventListener("pointermove", (e) => {
      const col = e.target instanceof Element ? e.target.closest(".progress-col") : null;
      if (!col) { tip.hidden = true; return; }
      tip.textContent = col.dataset.label;
      tip.hidden = false;
      const host = viewEl.querySelector(".progress-graph").getBoundingClientRect();
      const r = col.getBoundingClientRect();
      tip.style.left = `${r.left + r.width / 2 - host.left}px`;
      tip.style.top = `${Math.max(0, e.clientY - host.top - 34)}px`;
    });
    svg.addEventListener("pointerleave", () => { tip.hidden = true; });
  }

  function renderDay() {
    const d = current?.find((x) => x.dayStart === picked);
    if (!d) { dayEl.innerHTML = ""; return; }
    const date = new Date(d.dayStart).toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
    if (!d.total) {
      dayEl.innerHTML = `<div class="progress-day-head"><span>${esc(date)}</span></div>
        <div class="progress-empty">${isFuture(d.dayStart) ? "Still to come." : "No words added this day."}</div>`;
      return;
    }
    dayEl.innerHTML = `
      <div class="progress-day-head"><span>${esc(date)}</span><span class="progress-day-total">${esc(words(d.total))}</span></div>
      <ul class="progress-files">
        ${d.files.map((f) => `
          <li class="progress-file">
            <div class="progress-row"><span class="progress-name">${esc(names.get(f.id) || "Untitled")}</span><span class="progress-n">${fmtNum(f.added)}</span></div>
            ${f.sections.length > 1 || (f.sections[0] && f.sections[0].title) ? `
              <ul class="progress-sections">
                ${f.sections.map((s) => `<li class="progress-row"><span class="progress-name${s.title ? "" : " untitled"}">${esc(s.title || "Before the first heading")}</span><span class="progress-n">${fmtNum(s.added)}</span></li>`).join("")}
              </ul>` : ""}
          </li>`).join("")}
      </ul>`;
  }

  function pick(dayStart) {
    picked = dayStart;
    for (const el of viewEl.querySelectorAll("[data-day]")) {
      const on = Number(el.dataset.day) === picked;
      el.classList.toggle("picked", on);
      el.querySelector(".progress-bar")?.classList.toggle("picked", on);
    }
    renderDay();
  }

  viewEl.addEventListener("click", (e) => {
    const el = e.target instanceof Element ? e.target.closest("[data-day]") : null;
    if (el) pick(Number(el.dataset.day));
  });
  root.querySelector(".progress-tabs").addEventListener("click", (e) => {
    const b = e.target instanceof Element ? e.target.closest(".progress-tab") : null;
    if (!b || b.dataset.view === view) return;
    view = b.dataset.view;
    void show();
  });
  for (const b of root.querySelectorAll(".progress-step")) {
    b.addEventListener("click", () => {
      const d = new Date(year, month + Number(b.dataset.step), 1);
      if (d > now) return;
      year = d.getFullYear();
      month = d.getMonth();
      // The picked day follows into the month shown: the same date, or
      // that month's last if it is shorter.
      const p = new Date(picked);
      const last = new Date(year, month + 1, 0).getDate();
      picked = new Date(year, month, Math.min(p.getDate(), last)).getTime();
      void show();
    });
  }

  function close() {
    if (!open) return;
    open = null;
    window.removeEventListener("keydown", onKey, true);
    root.remove();
  }
  function onKey(e) {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopImmediatePropagation();
    close();
  }
  window.addEventListener("keydown", onKey, true);
  root.addEventListener("pointerdown", (e) => { if (e.target === root) close(); });
  root.querySelector(".progress-close").addEventListener("click", close);
  // Keys stay in the modal — the window-level shortcut fallback must not
  // hear them.
  root.addEventListener("keydown", (e) => e.stopPropagation());

  open = { close };
  void show();
}

/** A round step for the value axis: 1, 2 or 5 times a power of ten,
 *  giving three to five gridlines — never under one word. */
function niceStep(max) {
  const raw = max / 4;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const m = raw / pow;
  return Math.max(1, (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * pow);
}
