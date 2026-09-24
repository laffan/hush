/**
 * Courier — the quick-send sheet. Triple-tap Shift (courier-trigger.js)
 * and it slides up from the bottom of the window over whatever is on
 * screen, Zen Focus included; send a note somewhere else in the app or
 * out to the system, and it slides away again with the caret back where
 * it was.
 *
 * Three sections, top to bottom: the message type, the destinations for
 * that type (courier-destinations.js), and the message itself. Cancel
 * and Send close it; so do Escape and ⌘↩ / Ctrl↩ (which sends).
 *
 * The sheet lives in `document.body` at `--z-courier`, above the whole
 * modal band, because it has to be reachable from every context. Its
 * key events stop at the sheet on the way back up, so a keystroke typed
 * into it never reaches the window-level shortcut fallback or the
 * typing-fade listener; Escape is taken at window capture, ahead of
 * Zen's own Escape (document capture), so dismissing the sheet doesn't
 * also leave Zen.
 */

import { COURIER_TYPES, buildLocations, matchesFilter } from "./courier-destinations.js";
import { deliver } from "./courier-send.js";
import { lastType, lastLocation, rememberSend, rememberShortcutName } from "./courier-store.js";

const PLACEHOLDERS = {
  append: "Added to the end of the document…",
  "new-doc": "The first line becomes its title…",
  sticky: "Sticky note…",
  shortcut: "Passed to the shortcut as text…",
  things: "First line is the to-do, the rest its notes…",
};

let open = null; // the live sheet's handle, or null

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

export function toggleCourier(state) {
  if (open) { open.close(); return; }
  openCourier(state);
}

export function openCourier(state) {
  if (open) return;
  const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;

  const root = document.createElement("div");
  root.className = "courier-root";
  root.innerHTML = `
    <div class="courier-backdrop"></div>
    <div class="courier-sheet" role="dialog" aria-modal="true" aria-label="Courier">
      <div class="courier-section courier-type-row">
        <span class="courier-title">Courier</span>
        <select class="courier-type" aria-label="Message type">
          ${COURIER_TYPES.map((t) => `<option value="${t.id}">${esc(t.label)}</option>`).join("")}
        </select>
      </div>
      <div class="courier-section courier-locations">
        <input class="courier-filter" type="text" placeholder="Filter destinations…" aria-label="Filter destinations" autocomplete="off" spellcheck="false" />
        <div class="courier-list" role="listbox" aria-label="Destinations"></div>
        <input class="courier-other-name" type="text" placeholder="Shortcut name" aria-label="Shortcut name" autocomplete="off" spellcheck="false" hidden />
      </div>
      <div class="courier-section courier-message-row">
        <textarea class="courier-message" rows="4" aria-label="Message"></textarea>
      </div>
      <div class="courier-actions">
        <span class="courier-error" role="alert"></span>
        <button type="button" class="courier-cancel">Cancel</button>
        <button type="button" class="courier-send" disabled>Send</button>
      </div>
    </div>`;
  document.body.appendChild(root);

  const sheet = root.querySelector(".courier-sheet");
  const typeEl = root.querySelector(".courier-type");
  const filterEl = root.querySelector(".courier-filter");
  const listEl = root.querySelector(".courier-list");
  const otherEl = root.querySelector(".courier-other-name");
  const messageEl = root.querySelector(".courier-message");
  const sendEl = root.querySelector(".courier-send");
  const errorEl = root.querySelector(".courier-error");

  let rows = [];
  let visible = [];
  let selectedKey = null;
  let sending = false;
  let buildSeq = 0;

  const selected = () => rows.find((r) => r.key === selectedKey) || null;

  function syncControls() {
    const loc = selected();
    otherEl.hidden = !loc?.other;
    const needsName = !!loc?.other && !otherEl.value.trim();
    sendEl.disabled = sending || !loc || !messageEl.value.trim() || needsName;
    const phKey = loc?.action === "things" ? "things" : typeEl.value;
    messageEl.placeholder = PLACEHOLDERS[phKey] || "Message…";
  }

  function renderList() {
    visible = rows.filter((r) => matchesFilter(r, filterEl.value));
    if (!visible.some((r) => r.key === selectedKey)) selectedKey = visible[0]?.key ?? null;
    let lastGroup = null;
    const parts = [];
    for (const r of visible) {
      if (r.group !== lastGroup) {
        parts.push(`<div class="courier-group" role="presentation">${esc(r.group)}</div>`);
        lastGroup = r.group;
      }
      const sel = r.key === selectedKey;
      parts.push(`<div class="courier-row${sel ? " selected" : ""}" role="option" aria-selected="${sel}" data-key="${esc(r.key)}">
        <span class="courier-row-label">${esc(r.label)}</span>${r.detail ? `<span class="courier-row-detail">${esc(r.detail)}</span>` : ""}
      </div>`);
    }
    if (!visible.length) {
      parts.push(`<div class="courier-empty">${rows.length ? "Nothing matches." : "Nowhere to send this yet."}</div>`);
    }
    listEl.innerHTML = parts.join("");
    select(selectedKey);
  }

  function select(key) {
    selectedKey = key;
    for (const el of listEl.querySelectorAll(".courier-row")) {
      const on = el.dataset.key === key;
      el.classList.toggle("selected", on);
      el.setAttribute("aria-selected", String(on));
      // Scroll the list itself, never its ancestors (README-TECHNICAL:
      // scrollIntoView reaches every scrollable ancestor).
      if (on) {
        const top = el.offsetTop; // the list is position: relative
        if (top < listEl.scrollTop) listEl.scrollTop = top;
        else if (top + el.offsetHeight > listEl.scrollTop + listEl.clientHeight) {
          listEl.scrollTop = top + el.offsetHeight - listEl.clientHeight;
        }
      }
    }
    syncControls();
  }

  async function loadType(typeId, { focusMessage = false } = {}) {
    const seq = ++buildSeq;
    errorEl.textContent = "";
    listEl.innerHTML = `<div class="courier-empty">Loading…</div>`;
    const built = await buildLocations(state, typeId);
    if (seq !== buildSeq || !open) return;
    rows = built;
    const remembered = lastLocation(state, typeId);
    selectedKey = rows.some((r) => r.key === remembered) ? remembered : null;
    renderList();
    if (focusMessage && selectedKey && !selected()?.other) messageEl.focus();
    else filterEl.focus();
  }

  function moveSelection(delta) {
    if (!visible.length) return;
    const i = visible.findIndex((r) => r.key === selectedKey);
    const next = visible[Math.max(0, Math.min(visible.length - 1, (i < 0 ? 0 : i + delta)))];
    select(next.key);
  }

  async function send() {
    const loc = selected();
    const text = messageEl.value.replace(/\s+$/, "");
    if (!loc || !text.trim() || sending) return;
    sending = true;
    errorEl.textContent = "";
    syncControls();
    try {
      const shortcutName = otherEl.value.trim();
      const label = await deliver(state, loc, text, { shortcutName });
      if (loc.other) {
        rememberShortcutName(state, shortcutName);
        rememberSend(state, typeEl.value, `shortcut:${shortcutName}`);
      } else {
        rememberSend(state, typeEl.value, loc.key);
      }
      close();
      const { showImportToast } = await import("../editor/import-toast.js");
      showImportToast(label, "info");
    } catch (err) {
      console.error("Courier send failed:", err);
      errorEl.textContent = err?.message || String(err);
      sending = false;
      syncControls();
    }
  }

  function close() {
    if (!open) return;
    open = null;
    window.removeEventListener("keydown", onWindowKey, true);
    root.classList.remove("open");
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      root.remove();
    };
    sheet.addEventListener("transitionend", finish, { once: true });
    setTimeout(finish, 320);
    if (returnFocus && returnFocus.isConnected) {
      try { returnFocus.focus({ preventScroll: true }); } catch (_) {}
    }
  }

  // Escape at window capture — ahead of Zen's document-capture Escape.
  function onWindowKey(e) {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopImmediatePropagation();
    close();
  }
  window.addEventListener("keydown", onWindowKey, true);

  sheet.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void send();
    }
  });

  filterEl.addEventListener("input", renderList);
  filterEl.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); moveSelection(1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); moveSelection(-1); }
    else if (e.key === "Enter" && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      if (selected()?.other) otherEl.focus();
      else if (selectedKey) messageEl.focus();
    }
  });
  otherEl.addEventListener("input", syncControls);
  otherEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.metaKey && !e.ctrlKey) { e.preventDefault(); messageEl.focus(); }
  });
  messageEl.addEventListener("input", syncControls);

  // Commit on pointerdown, the way every menu floating over an editor
  // does here (README-TECHNICAL: click is too late on iOS).
  listEl.addEventListener("pointerdown", (e) => {
    const row = e.target instanceof Element ? e.target.closest(".courier-row") : null;
    if (!row) return;
    e.preventDefault();
    select(row.dataset.key);
    if (selected()?.other) otherEl.focus();
  });

  typeEl.addEventListener("change", () => { filterEl.value = ""; void loadType(typeEl.value); });
  root.querySelector(".courier-backdrop").addEventListener("pointerdown", (e) => { e.preventDefault(); close(); });
  root.querySelector(".courier-cancel").addEventListener("click", close);
  sendEl.addEventListener("click", () => void send());

  open = { close };

  const initialType = COURIER_TYPES.some((t) => t.id === lastType(state)) ? lastType(state) : COURIER_TYPES[0].id;
  typeEl.value = initialType;
  requestAnimationFrame(() => root.classList.add("open"));
  void loadType(initialType, { focusMessage: true });
}
