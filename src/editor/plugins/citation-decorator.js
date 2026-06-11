/**
 * Pandoc-style Zotero citations inside the doc editor.
 *
 * Three responsibilities:
 *   1. Decorate every citation as a tinted pill that keeps its brackets
 *      visible (unlike regular links, whose brackets are hidden). A
 *      citation is `[@citekey]` optionally followed by a Zotero deep
 *      link `(zotero://…)`, and citations chain with semicolons:
 *          [@a](zotero://…);@b;@c;[@d](zotero://…)
 *      Every item in the chain is decorated individually — bracketed
 *      items render as `[@key]`, bare continuations as `@key`. The raw
 *      markdown (deep link included) shows whenever the cursor sits
 *      inside an item.
 *   2. Hovering a rendered citation shows a small action card: "View in
 *      Zotero", plus a PDF action — "Save PDF" (downloads via the
 *      existing Zotero Save PDF pipeline) when the reference has a PDF
 *      that isn't in Hush yet, or "View PDF" when it is.
 *   3. Typing `[@` pops a floating search over the cached Zotero
 *      references (mirroring the `[[` wikilink selector). Enter / Tab
 *      commits `[@citekey](zotero://select/library/items/KEY)`.
 */

import { ViewPlugin, Decoration, WidgetType, EditorView, keymap } from "@codemirror/view";
import { RangeSetBuilder, Prec } from "@codemirror/state";
import { isIOS } from "../../settings/settings-ui.js";
import { openCitationPopup } from "../../links/citation-popup.js";

// Keep in sync with CITE_RE in doc-export-modal.js and is_citekey_char
// in src-tauri/src/typst_export/markdown.rs.
const CITEKEY_BODY = "[A-Za-z0-9_:.+-]+";
const BRACKET_ITEM_RE = new RegExp(`^\\[@(${CITEKEY_BODY})\\](?:\\(([^)\\n]*)\\))?`);
const BARE_ITEM_RE = new RegExp(`^@(${CITEKEY_BODY})`);

/** Match a single citation item at `pos` in `text`. Chains must start
 *  with the bracketed form; continuations after `;` may be bare. */
function matchItem(text, pos, requireBracket) {
  if (text[pos] === "[" && text[pos + 1] === "@") {
    const m = BRACKET_ITEM_RE.exec(text.slice(pos));
    if (m) return { from: pos, to: pos + m[0].length, citekey: m[1], url: m[2] || null, bracketed: true };
    return null;
  }
  if (!requireBracket && text[pos] === "@") {
    const m = BARE_ITEM_RE.exec(text.slice(pos));
    if (m) return { from: pos, to: pos + m[0].length, citekey: m[1], url: null, bracketed: false };
  }
  return null;
}

/** Parse every citation item in a line of text. Returns a flat list of
 *  `{ from, to, citekey, url, bracketed }` with line-local offsets —
 *  semicolon separators between chained items are left untouched. */
export function parseCitations(text) {
  const items = [];
  let i = 0;
  while (i < text.length) {
    if (text[i] === "[" && text[i + 1] === "@" && text[i - 1] !== "!") {
      const first = matchItem(text, i, true);
      if (first) {
        items.push(first);
        let j = first.to;
        while (text[j] === ";") {
          const next = matchItem(text, j + 1, false);
          if (!next) break;
          items.push(next);
          j = next.to;
        }
        i = j;
        continue;
      }
    }
    i++;
  }
  return items;
}

// ───────────────────── hover action card ─────────────────────

let card = null;
let cardAnchor = null;
let showTimer = null;
let hideTimer = null;

function destroyCard() {
  clearTimeout(showTimer);
  clearTimeout(hideTimer);
  showTimer = null;
  hideTimer = null;
  if (card) { card.remove(); card = null; cardAnchor = null; }
}

function scheduleHide() {
  clearTimeout(hideTimer);
  hideTimer = setTimeout(destroyCard, 300);
}

function cancelHide() {
  clearTimeout(hideTimer);
  hideTimer = null;
}

async function openUrl(url) {
  if (typeof window !== "undefined" && window.__TAURI_INTERNALS__) {
    try {
      const opener = await import("@tauri-apps/plugin-opener");
      await opener.openUrl(url);
      return;
    } catch (_) { /* fall through */ }
  }
  window.open(url, "_blank");
}

function sanitizeFilename(s) {
  return (s || "PDF")
    .replace(/[\\/:*?"<>|]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 60) || "PDF";
}

/** Look up the Hush PDF registry entry matching this citation, if any. */
function findHushPdf(registry, citekey, ref) {
  for (const [fileId, meta] of Object.entries(registry)) {
    if ((citekey && meta.citekey && meta.citekey === citekey) ||
        (ref && meta.zoteroItemKey && meta.zoteroItemKey === ref.key)) {
      return { fileId, meta };
    }
  }
  return null;
}

function makeBtn(label, onClick) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "citation-card-btn";
  btn.textContent = label;
  if (onClick) btn.addEventListener("click", onClick);
  else btn.disabled = true;
  return btn;
}

async function buildCardContent(el, citekey, url, appState) {
  let ref = null;
  try {
    const { loadReferences } = await import("../../zotero.js");
    const refs = await loadReferences();
    ref = (refs || []).find((r) => r.citekey === citekey) || null;
  } catch (_) { /* no Zotero configured — card still shows the link */ }

  const title = document.createElement("div");
  title.className = "citation-card-title";
  title.textContent = ref
    ? (ref.shortTitle || ref.title) + (ref.year ? ` (${ref.year})` : "")
    : `@${citekey}`;
  el.appendChild(title);
  if (!ref) {
    const note = document.createElement("div");
    note.className = "citation-card-note";
    note.textContent = "Not found in Zotero library";
    el.appendChild(note);
  }

  const actions = document.createElement("div");
  actions.className = "citation-card-actions";
  el.appendChild(actions);

  const zoteroUrl = url || (ref ? `zotero://select/library/items/${ref.key}` : null);
  if (zoteroUrl) {
    actions.appendChild(makeBtn("View in Zotero", (e) => {
      e.preventDefault();
      void openUrl(zoteroUrl);
      destroyCard();
    }));
  }

  // PDF action — resolve against the Hush PDF registry first, then the
  // reference's Zotero attachments.
  const pdfAtt = ref?.attachments?.find((a) => a.isPdf) || null;
  let registry = {};
  let isPdfDownloaded = () => false;
  try {
    const pdfSync = await import("../../sync/pdf-sync.js");
    registry = pdfSync.getPdfRegistry();
    isPdfDownloaded = pdfSync.isPdfDownloaded;
  } catch (_) { /* registry unavailable */ }
  const existing = findHushPdf(registry, citekey, ref);

  if (existing && isPdfDownloaded(existing.fileId)) {
    actions.appendChild(makeBtn("View PDF", (e) => {
      e.preventDefault();
      void appState?.openPdf?.(existing.fileId);
      destroyCard();
    }));
  } else if (existing) {
    actions.appendChild(makeBtn("Saving PDF…", null));
  } else if (ref && pdfAtt && appState?.registerPdfPlaceholder) {
    const btn = makeBtn("Save PDF", async (e) => {
      e.preventDefault();
      btn.disabled = true;
      btn.textContent = "Saving PDF…";
      try {
        const baseName = sanitizeFilename(ref.shortTitle || ref.title || "PDF");
        const result = await appState.registerPdfPlaceholder(baseName, {
          zoteroAttKey: pdfAtt.key,
          zoteroItemKey: ref.key,
          zoteroTitle: ref.title || "Untitled",
          zoteroAuthors: ref.authors || "",
          zoteroFirstAuthor: ref.firstAuthor || "",
          zoteroYear: ref.year || "",
          zoteroCitekey: ref.citekey || "",
        });
        if (result) {
          const { startBatchDownload } = await import("../../sync/pdf-sync.js");
          startBatchDownload([result.fileId], appState);
        }
      } catch (err) {
        console.error("Save PDF from citation failed:", err);
        btn.textContent = "Save failed";
      }
    });
    actions.appendChild(btn);
  }
}

function positionCard(el, rect) {
  const margin = 4;
  el.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - 280))}px`;
  el.style.top = `${rect.bottom + margin}px`;
  el.style.visibility = "hidden";
  requestAnimationFrame(() => {
    if (!el.isConnected) return;
    const h = el.getBoundingClientRect().height;
    if (rect.bottom + margin + h > window.innerHeight - 8 && rect.top - margin - h > 8) {
      el.style.top = `${rect.top - margin - h}px`;
    }
    el.style.visibility = "visible";
  });
}

function showCardFor(span, citekey, url, appState) {
  if (!span.isConnected) return;
  if (cardAnchor === span && card) { cancelHide(); return; }
  destroyCard();
  card = document.createElement("div");
  card.className = "citation-hover-card";
  card.addEventListener("mouseenter", cancelHide);
  card.addEventListener("mouseleave", scheduleHide);
  document.body.appendChild(card);
  cardAnchor = span;
  positionCard(card, span.getBoundingClientRect());
  void buildCardContent(card, citekey, url, appState).then(() => {
    // Content arrived async — re-measure in case the card grew.
    if (card && cardAnchor === span && span.isConnected) {
      positionCard(card, span.getBoundingClientRect());
    }
  });
}

function attachHover(span, citekey, url, appState) {
  if (isIOS()) return; // no hover on touch
  span.addEventListener("mouseenter", () => {
    cancelHide();
    clearTimeout(showTimer);
    showTimer = setTimeout(() => showCardFor(span, citekey, url, appState), 250);
  });
  span.addEventListener("mouseleave", () => {
    clearTimeout(showTimer);
    scheduleHide();
  });
}

// ───────────────────── decorations ─────────────────────

class CitationWidget extends WidgetType {
  constructor(citekey, url, bracketed, appState) {
    super();
    this.citekey = citekey;
    this.url = url;
    this.bracketed = bracketed;
    this.appState = appState;
  }

  eq(other) {
    return this.citekey === other.citekey
      && this.url === other.url
      && this.bracketed === other.bracketed;
  }

  toDOM() {
    const span = document.createElement("span");
    span.className = "cm-citation-rendered" + (this.url ? " linked" : "");
    // Citations always show their brackets — only the deep-link URL is
    // hidden in the rendered form.
    span.textContent = this.bracketed ? `[@${this.citekey}]` : `@${this.citekey}`;
    span.dataset.citekey = this.citekey;
    if (this.url) span.dataset.citeUrl = this.url;
    attachHover(span, this.citekey, this.url, this.appState);
    return span;
  }

  ignoreEvent() { return false; }
}

function buildDecorations(view, appState) {
  const builder = new RangeSetBuilder();
  const doc = view.state.doc;
  const cursors = view.state.selection.ranges.map((r) => ({
    from: Math.min(r.from, r.to),
    to: Math.max(r.from, r.to),
  }));

  for (let i = 1; i <= doc.lines; i++) {
    const line = doc.line(i);
    if (!line.text.includes("[@")) continue;
    for (const item of parseCitations(line.text)) {
      const from = line.from + item.from;
      const to = line.from + item.to;
      // Show the raw markdown while the cursor is inside this item so
      // the citekey and deep link stay editable.
      const cursorInside = cursors.some(
        (c) =>
          (c.from >= from && c.from <= to) ||
          (c.to >= from && c.to <= to) ||
          (c.from <= from && c.to >= to),
      );
      if (cursorInside) continue;
      builder.add(from, to, Decoration.replace({
        widget: new CitationWidget(item.citekey, item.url, item.bracketed, appState),
      }));
    }
  }
  return builder.finish();
}

/** Find the citation item at a document position, or null. */
function citationAtPos(doc, pos) {
  const line = doc.lineAt(pos);
  for (const item of parseCitations(line.text)) {
    const from = line.from + item.from;
    const to = line.from + item.to;
    if (pos >= from && pos <= to) return item;
  }
  return null;
}

// ───────────────────── click handling ─────────────────────

/** On iOS, modifier state from a paired keyboard doesn't always reach
 *  touch-synthesized events — mirror link-decorator's tracker. */
let _modifierHeld = false;
if (isIOS()) {
  document.addEventListener("keydown", (e) => {
    if (e.key === "Meta" || e.key === "Control") _modifierHeld = true;
  });
  document.addEventListener("keyup", (e) => {
    if (e.key === "Meta" || e.key === "Control") _modifierHeld = false;
  });
  window.addEventListener("blur", () => { _modifierHeld = false; });
}

function hasModifier(e) {
  return e.metaKey || e.ctrlKey || _modifierHeld;
}

function createClickHandler() {
  return EditorView.domEventHandlers({
    mousedown(e, view) {
      if (!hasModifier(e)) return false;
      const widget = e.target.closest?.(".cm-citation-rendered");
      if (widget?.dataset.citeUrl) {
        e.preventDefault();
        void openUrl(widget.dataset.citeUrl);
        return true;
      }
      if (widget) return false;
      const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
      if (pos == null) return false;
      const item = citationAtPos(view.state.doc, pos);
      if (item?.url) {
        e.preventDefault();
        void openUrl(item.url);
        return true;
      }
      return false;
    },
  });
}

// ───────────────────── `[@` search trigger ─────────────────────

/** Find an open `[@…` whose closing `]` hasn't been typed yet, with the
 *  cursor inside. Returns `{ from, to, query }` of the inner query span
 *  (from is just past `[@`), or null. */
function findActiveCitationContext(state) {
  const head = state.selection.main.head;
  const line = state.doc.lineAt(head);
  const text = line.text;
  const localCursor = head - line.from;
  let openIdx = -1;
  for (let i = localCursor - 1; i >= 1; i--) {
    const ch = text[i];
    if (ch === "]" || ch === ")") return null; // already closed
    if (ch === "@" && text[i - 1] === "[") { openIdx = i + 1; break; }
    if (ch === "[" || ch === "@") return null; // plain bracket / bare @
  }
  if (openIdx < 0) return null;
  return { from: line.from + openIdx, to: head, query: text.slice(openIdx, localCursor) };
}

/** Popup lifecycle for one editor — mirrors the wikilink controller. */
function createSearchController(view) {
  let popup = null;
  let activeRange = null;
  let scheduled = false;
  let refs = null;
  let refsLoading = false;

  function close() {
    if (popup) { popup.destroy(); popup = null; }
    activeRange = null;
  }

  function anchorAt(pos) {
    const coords = view.coordsAtPos(pos);
    if (!coords) return null;
    return { left: coords.left, top: coords.top, bottom: coords.bottom };
  }

  function pick(ref) {
    if (!activeRange) return;
    if (!ref) { close(); return; }
    const citekey = ref.citekey || ref.key;
    const insert = `${citekey}](zotero://select/library/items/${ref.key})`;
    view.dispatch({
      changes: { from: activeRange.from, to: activeRange.to, insert },
      selection: { anchor: activeRange.from + insert.length },
    });
    close();
  }

  function ensureRefs() {
    if (refs || refsLoading) return;
    refsLoading = true;
    import("../../zotero.js")
      .then((m) => m.loadReferences())
      .then((r) => { refs = r || []; refsLoading = false; sync(); })
      .catch(() => { refs = []; refsLoading = false; });
  }

  function runSync() {
    const ctx = findActiveCitationContext(view.state);
    if (!ctx) { close(); return; }
    if (!refs) { ensureRefs(); return; }
    if (!refs.length) return; // Zotero not configured — stay inert
    activeRange = { from: ctx.from, to: ctx.to };
    if (!popup) {
      const anchor = anchorAt(ctx.from);
      if (!anchor) return;
      popup = openCitationPopup({
        refs,
        anchor,
        initialQuery: ctx.query,
        onPick: (r) => pick(r),
      });
    } else {
      popup.update(ctx.query);
      const anchor = anchorAt(ctx.from);
      if (anchor) popup.setAnchor(anchor);
    }
  }

  // Defer layout reads out of the ViewPlugin.update() pass.
  function sync() {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      runSync();
    });
  }

  return {
    sync,
    close,
    moveSelection(delta) { popup?.moveSelection(delta); },
    commit() { popup?.commit(); },
    isOpen() { return !!popup; },
  };
}

export function createCitationPlugin(appState) {
  let controller = null;

  const renderPlugin = ViewPlugin.fromClass(
    class {
      constructor(view) {
        controller = createSearchController(view);
        this.decorations = buildDecorations(view, appState);
      }
      update(update) {
        if (update.docChanged || update.selectionSet || update.viewportChanged) {
          this.decorations = buildDecorations(update.view, appState);
        }
        if (update.docChanged || update.selectionSet) {
          controller?.sync();
        }
      }
      destroy() {
        controller?.close();
        destroyCard();
      }
    },
    { decorations: (v) => v.decorations },
  );

  const citationKeymap = Prec.highest(keymap.of([
    { key: "ArrowDown", run: () => controller?.isOpen() ? (controller.moveSelection(1), true) : false },
    { key: "ArrowUp",   run: () => controller?.isOpen() ? (controller.moveSelection(-1), true) : false },
    { key: "Enter",     run: () => controller?.isOpen() ? (controller.commit(), true) : false },
    { key: "Tab",       run: () => controller?.isOpen() ? (controller.commit(), true) : false },
    { key: "Escape",    run: () => controller?.isOpen() ? (controller.close(), true) : false },
  ]));

  return [renderPlugin, citationKeymap, createClickHandler()];
}
