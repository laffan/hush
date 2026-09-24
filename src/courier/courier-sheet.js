/**
 * Courier — the quick-send sheet. Triple-tap Shift (courier-trigger.js)
 * and it slides up from the bottom of the window over whatever is on
 * screen, Zen Focus included; send a note and it slides away again with
 * the caret back where it was.
 *
 * Two columns. The left chooses: **Sticky** or **Append** across the
 * top; a sticky adds a second row — Document, Desk, Global — and then
 * the search over documents or desks (a global sticky needs none). The
 * right is the thing itself, written in place: a sticky note (the real
 * sticky markup and palette) whose text you type straight into, or the
 * end of the target document with a live editor after it
 * (courier-append-editor.js). What's typed carries across a switch
 * between the two. Escape / Cancel dismiss; ⌘↩ / Ctrl↩ sends.
 *
 * The sheet lives in `document.body` at `--z-courier`, above the whole
 * modal band. Its key events stop at the sheet on the way back up, so a
 * keystroke typed into it never reaches the window-level shortcut
 * fallback or the typing-fade listener; Escape is taken at window
 * capture, ahead of Zen's own Escape (document capture), so dismissing
 * the sheet doesn't also leave Zen.
 */

import { MODES, STICKY_SCOPES, buildLocations, matchesFilter } from "./courier-destinations.js";
import { deliver, readDocumentText } from "./courier-send.js";
import { lastMode, lastScope, lastLocation, rememberSend, slotFor } from "./courier-store.js";
import { mountAppendEditor, documentTail } from "./courier-append-editor.js";
import { ctxIconFor, DEFAULT_FONT } from "../sticky/sticky-shared.js";

/** Scope → the sticky kind whose paper and glyph it wears. */
const STICKY_KIND = { document: "file", desk: "desk", global: "global" };

let open = null; // the live sheet's handle, or null

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function segButtons(items, cls) {
  return items.map((it) => `<button type="button" class="${cls}" data-id="${it.id}">${esc(it.label)}</button>`).join("");
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
      <div class="courier-left">
        <div class="courier-seg courier-modes" role="group" aria-label="What to make">${segButtons(MODES, "courier-mode")}</div>
        <div class="courier-seg courier-scopes" role="group" aria-label="Sticky scope">${segButtons(STICKY_SCOPES, "courier-scope")}</div>
        <input class="courier-filter" type="text" aria-label="Search" autocomplete="off" spellcheck="false" />
        <div class="courier-list" role="listbox" aria-label="Destinations"></div>
      </div>
      <div class="courier-right">
        <div class="courier-canvas"></div>
        <div class="courier-actions">
          <span class="courier-error" role="alert"></span>
          <button type="button" class="courier-cancel">Cancel</button>
          <button type="button" class="courier-send" disabled>Send</button>
        </div>
      </div>
    </div>`;
  document.body.appendChild(root);

  const sheet = root.querySelector(".courier-sheet");
  const scopesEl = root.querySelector(".courier-scopes");
  const filterEl = root.querySelector(".courier-filter");
  const listEl = root.querySelector(".courier-list");
  const canvasEl = root.querySelector(".courier-canvas");
  const sendEl = root.querySelector(".courier-send");
  const errorEl = root.querySelector(".courier-error");

  let mode = MODES.some((m) => m.id === lastMode(state)) ? lastMode(state) : "sticky";
  let scope = STICKY_SCOPES.some((s) => s.id === lastScope(state)) ? lastScope(state) : "document";
  let rows = [];
  let visible = [];
  let selectedKey = null;
  let sending = false;
  let surfaceSeq = 0;
  let message = "";          // what's been written, carried across rebuilds
  let stickyText = null;     // the sticky's textarea while it's mounted
  let appendEditor = null;   // the append editor while it's mounted
  let surfaceKey = null;     // what the mounted surface was built for
  const docText = new Map(); // fileId → text, for the append surface

  const selected = () => rows.find((r) => r.key === selectedKey) || null;
  const needsLocation = () => !(mode === "sticky" && scope === "global");

  function currentMessage() {
    if (stickyText) return stickyText.value;
    if (appendEditor) return appendEditor.getMessage();
    return message;
  }

  function syncControls() {
    sendEl.disabled = sending || !currentMessage().trim() || (needsLocation() && !selected());
  }

  function unmountSurface() {
    message = currentMessage();
    stickyText = null;
    if (appendEditor) { appendEditor.destroy(); appendEditor = null; }
    canvasEl.innerHTML = "";
    surfaceKey = null;
  }

  function mountSticky() {
    const kind = STICKY_KIND[scope];
    const loc = selected();
    const where = scope === "global" ? "Global" : (loc?.label || "");
    canvasEl.className = "courier-canvas courier-sticky-stage";
    canvasEl.innerHTML = `
      <div class="sticky-note sticky-${kind} active courier-sticky">
        <div class="sticky-note-titlebar">
          <span class="sticky-note-btn sticky-note-context" aria-hidden="true">${ctxIconFor(kind)}</span>
          <span class="sticky-note-excerpt courier-sticky-where">${esc(where)}</span>
        </div>
        <textarea class="sticky-note-text" placeholder="Note…" spellcheck="false" aria-label="Sticky note"></textarea>
      </div>`;
    stickyText = canvasEl.querySelector(".sticky-note-text");
    stickyText.style.fontSize = DEFAULT_FONT + "px";
    stickyText.value = message;
    stickyText.addEventListener("input", syncControls);
    stickyText.focus();
    stickyText.setSelectionRange(message.length, message.length);
  }

  async function mountAppend(loc, seq) {
    canvasEl.className = "courier-canvas courier-doc-stage";
    if (!loc) {
      canvasEl.innerHTML = `<div class="courier-canvas-hint">Choose a document to append to.</div>`;
      return;
    }
    let existing = docText.get(loc.fileId);
    if (existing == null) {
      try { existing = await readDocumentText(state, loc.fileId); }
      catch (_) { existing = ""; }
      docText.set(loc.fileId, existing);
      if (seq !== surfaceSeq || !open) return;
    }
    const { tail, clipped } = documentTail(existing);
    canvasEl.innerHTML = `<div class="courier-doc-name">${esc(loc.label)}</div><div class="courier-doc-editor"></div>`;
    appendEditor = mountAppendEditor(state, canvasEl.querySelector(".courier-doc-editor"), {
      existing: tail,
      message,
      clipped,
      onInput: syncControls,
      onSend: () => void send(),
    });
    appendEditor.focus();
    syncControls();
  }

  /** Hand the caret back to whatever is being written on. The append
   *  editor mounts after an await and focuses itself when it lands. */
  function focusSurface() {
    if (stickyText) stickyText.focus();
    else appendEditor?.focus();
  }

  /** Build the right-hand surface for the current mode / scope / pick —
   *  or, for a sticky whose destination merely changed, just relabel it
   *  so the caret stays where it is. */
  function renderSurface() {
    const loc = selected();
    const key = mode === "sticky" ? `sticky:${scope}` : `append:${loc?.fileId || ""}`;
    if (key === surfaceKey) {
      const where = canvasEl.querySelector(".courier-sticky-where");
      if (where) where.textContent = scope === "global" ? "Global" : (loc?.label || "");
      syncControls();
      return;
    }
    const seq = ++surfaceSeq;
    unmountSurface();
    surfaceKey = key;
    if (mode === "sticky") mountSticky();
    else void mountAppend(loc, seq);
    syncControls();
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
    renderSurface();
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
      parts.push(`<div class="courier-row" role="option" data-key="${esc(r.key)}">
        <span class="courier-row-label">${esc(r.label)}</span>${r.detail ? `<span class="courier-row-detail">${esc(r.detail)}</span>` : ""}
      </div>`);
    }
    if (!visible.length && needsLocation()) {
      parts.push(`<div class="courier-empty">${rows.length ? "Nothing matches." : "Nothing here yet."}</div>`);
    }
    listEl.innerHTML = parts.join("");
    select(selectedKey);
  }

  /** Re-lay the left column for the current mode / scope. */
  function applyChoice() {
    errorEl.textContent = "";
    for (const b of root.querySelectorAll(".courier-mode")) b.classList.toggle("active", b.dataset.id === mode);
    for (const b of root.querySelectorAll(".courier-scope")) b.classList.toggle("active", b.dataset.id === scope);
    scopesEl.hidden = mode !== "sticky";
    const searchable = needsLocation();
    filterEl.hidden = !searchable;
    listEl.hidden = !searchable;
    filterEl.value = "";
    filterEl.placeholder = mode === "sticky" && scope === "desk" ? "Search desks…" : "Search documents…";
    rows = searchable ? buildLocations(state, mode, scope) : [];
    const remembered = lastLocation(state, slotFor(mode, scope));
    selectedKey = rows.some((r) => r.key === remembered) ? remembered : null;
    renderList();
  }

  function moveSelection(delta) {
    if (!visible.length) return;
    const i = visible.findIndex((r) => r.key === selectedKey);
    select(visible[Math.max(0, Math.min(visible.length - 1, i < 0 ? 0 : i + delta))].key);
  }

  async function send() {
    const text = currentMessage().replace(/\s+$/, "");
    if (sendEl.disabled || !text.trim()) return;
    sending = true;
    errorEl.textContent = "";
    syncControls();
    const location = selected();
    try {
      const label = await deliver(state, { mode, scope, location }, text);
      rememberSend(state, mode, mode === "sticky" ? scope : null, location?.key || null);
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
    appendEditor?.destroy();
    appendEditor = null;
    let done = false;
    const finish = () => { if (!done) { done = true; root.remove(); } };
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
    // The append editor takes ⌘↩ itself (and cancels it); don't send twice.
    if (e.defaultPrevented) return;
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void send();
    }
  });

  root.querySelector(".courier-modes").addEventListener("click", (e) => {
    const b = e.target instanceof Element ? e.target.closest(".courier-mode") : null;
    if (b && b.dataset.id !== mode) { mode = b.dataset.id; applyChoice(); }
    if (b) focusSurface();
  });
  scopesEl.addEventListener("click", (e) => {
    const b = e.target instanceof Element ? e.target.closest(".courier-scope") : null;
    if (b && b.dataset.id !== scope) { scope = b.dataset.id; applyChoice(); }
    if (b) focusSurface();
  });

  filterEl.addEventListener("input", renderList);
  filterEl.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); moveSelection(1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); moveSelection(-1); }
    else if (e.key === "Enter" && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      focusSurface();
    }
  });

  // Commit on pointerdown, the way every menu floating over an editor
  // does here (README-TECHNICAL: click is too late on iOS).
  listEl.addEventListener("pointerdown", (e) => {
    const row = e.target instanceof Element ? e.target.closest(".courier-row") : null;
    if (!row) return;
    e.preventDefault();
    select(row.dataset.key);
  });

  root.querySelector(".courier-backdrop").addEventListener("pointerdown", (e) => { e.preventDefault(); close(); });
  root.querySelector(".courier-cancel").addEventListener("click", close);
  sendEl.addEventListener("click", () => void send());

  open = { close };
  applyChoice();
  requestAnimationFrame(() => root.classList.add("open"));
}
