/**
 * Courier — the quick-send sheet. Triple-tap Shift (courier-trigger.js)
 * and it slides up from the bottom of the window over whatever is on
 * screen, Zen Focus included; send a note and it slides away again with
 * the caret back where it was.
 *
 * Two columns. The left chooses: **Sticky** or **Append** across the
 * top; a sticky adds a second row — Document, Desk, Global — and then
 * the search over documents or desks (a global sticky needs none). The
 * right is the message and a live preview of exactly what Send will
 * make: the sticky itself in its scope's paper colour, or the end of the
 * target document with the new paragraph rendered as markdown beneath
 * it. Escape / Cancel dismiss; ⌘↩ / Ctrl↩ sends.
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
import { markdownToHtml } from "../editor/google-docs/markdown-to-html.js";

/** How much of the target document the append preview shows above the
 *  new paragraph — enough to recognise where it lands. */
const TAIL_CHARS = 480;

const STICKY_PAPER = { document: "sticky-file", desk: "sticky-desk", global: "sticky-global" };

let open = null; // the live sheet's handle, or null

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function segButtons(items, cls) {
  return items.map((it) => `<button type="button" class="${cls}" data-id="${it.id}">${esc(it.label)}</button>`).join("");
}

/** The last stretch of a document, cut at a paragraph break and clear of
 *  its frontmatter. */
function documentTail(text) {
  const body = text.replace(/^---\n[\s\S]*?\n---\n?/, "").replace(/\s+$/, "");
  if (body.length <= TAIL_CHARS) return { tail: body, clipped: false };
  const cut = body.lastIndexOf("\n\n", body.length - TAIL_CHARS);
  return { tail: body.slice(cut >= 0 ? cut + 2 : body.length - TAIL_CHARS), clipped: true };
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
        <textarea class="courier-message" rows="3" placeholder="Write…" aria-label="Message"></textarea>
        <div class="courier-preview" aria-label="Preview"></div>
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
  const messageEl = root.querySelector(".courier-message");
  const previewEl = root.querySelector(".courier-preview");
  const sendEl = root.querySelector(".courier-send");
  const errorEl = root.querySelector(".courier-error");

  let mode = MODES.some((m) => m.id === lastMode(state)) ? lastMode(state) : "sticky";
  let scope = STICKY_SCOPES.some((s) => s.id === lastScope(state)) ? lastScope(state) : "document";
  let rows = [];
  let visible = [];
  let selectedKey = null;
  let sending = false;
  let previewSeq = 0;
  const docText = new Map(); // fileId → text, for the append preview

  const selected = () => rows.find((r) => r.key === selectedKey) || null;
  const needsLocation = () => !(mode === "sticky" && scope === "global");

  function syncControls() {
    sendEl.disabled = sending || !messageEl.value.trim() || (needsLocation() && !selected());
  }

  async function renderPreview() {
    const seq = ++previewSeq;
    const text = messageEl.value.replace(/\s+$/, "");
    const loc = selected();
    if (mode === "sticky") {
      const where = scope === "global" ? "Global" : (loc?.label || (scope === "desk" ? "Choose a desk" : "Choose a document"));
      previewEl.innerHTML = `
        <div class="courier-sticky-preview ${STICKY_PAPER[scope]}">
          <div class="courier-sticky-head">${esc(where)}</div>
          <div class="courier-sticky-body${text ? "" : " empty"}">${esc(text || "Your note")}</div>
        </div>`;
      return;
    }
    if (!loc) {
      previewEl.innerHTML = `<div class="courier-preview-empty">Choose a document to append to.</div>`;
      return;
    }
    let existing = docText.get(loc.fileId);
    if (existing == null) {
      try { existing = await readDocumentText(state, loc.fileId); }
      catch (_) { existing = ""; }
      docText.set(loc.fileId, existing);
      if (seq !== previewSeq || !open) return;
    }
    const { tail, clipped } = documentTail(existing);
    previewEl.innerHTML = `
      <div class="courier-doc-preview">
        <div class="courier-doc-name">${esc(loc.label)}</div>
        <div class="courier-doc-tail${clipped ? " clipped" : ""}">${tail ? markdownToHtml(tail) : ""}</div>
        <div class="courier-doc-new${text ? "" : " empty"}">${text ? markdownToHtml(text) : "<p>Your paragraph</p>"}</div>
      </div>`;
    // Keep the landing point in view: the new paragraph sits at the end.
    previewEl.scrollTop = previewEl.scrollHeight;
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
    void renderPreview();
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
    const text = messageEl.value.replace(/\s+$/, "");
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
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void send();
    }
  });

  root.querySelector(".courier-modes").addEventListener("click", (e) => {
    const b = e.target instanceof Element ? e.target.closest(".courier-mode") : null;
    if (!b || b.dataset.id === mode) return;
    mode = b.dataset.id;
    applyChoice();
  });
  scopesEl.addEventListener("click", (e) => {
    const b = e.target instanceof Element ? e.target.closest(".courier-scope") : null;
    if (!b || b.dataset.id === scope) return;
    scope = b.dataset.id;
    applyChoice();
  });

  filterEl.addEventListener("input", renderList);
  filterEl.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); moveSelection(1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); moveSelection(-1); }
    else if (e.key === "Enter" && !e.metaKey && !e.ctrlKey) { e.preventDefault(); messageEl.focus(); }
  });

  let previewFrame = 0;
  messageEl.addEventListener("input", () => {
    syncControls();
    if (previewFrame) return;
    previewFrame = requestAnimationFrame(() => { previewFrame = 0; void renderPreview(); });
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
  messageEl.focus();
}
