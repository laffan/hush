/**
 * Zotero highlight browser pane.
 *
 * Lives as a third pane fileType ("zotero-highlights") alongside docs
 * and notebooks. The pane has three internal modes that swap the body:
 *
 *   1. search       — fuzzy search the local Zotero reference cache
 *   2. pickAttach   — only entered when the chosen item has 2+ PDFs
 *   3. annotations  — title header, search box, color column, list
 *
 * The chosen attachment is persisted on `pane.zotero` so a restart
 * lands directly back in mode 3. The annotation cache lives on disk
 * (Rust side, `{data_dir}/zotero_annotations/{attKey}.json`) so the
 * Zotero API isn't pinged on each open.
 */

import { createPane } from "../pane/pane-manager.js";
import { schedulePersist } from "../pane/pane-persistence.js";
import { loadReferences, fuzzySearch } from "../zotero.js";
import { getAnnotations, groupByColor } from "../zotero-annotations.js";
import { startTextDrag } from "../pane/text-drag.js";

/** Anchor matches the palette's "open as pane" placement. */
const OPEN_X = 80;
const OPEN_Y = 80;

/** Public entry point — invoked by the command palette. */
export async function openZoteroHighlightPane(state) {
  const fileId = "zotero:" + crypto.randomUUID();
  // Default ownerContext (current doc/notebook). Pin/attach behavior
  // matches every other pane type — no special-casing.
  await createPane(fileId, "Zotero highlights", "zotero-highlights", OPEN_X, OPEN_Y);
}

/** Mount entry point — invoked by `pane-content.js::loadPaneContent`
 *  once the pane DOM exists. Hands ownership of `pane._content` to this
 *  module's renderer. */
export async function mountZoteroHighlightPane(pane, appState) {
  pane._content.classList.add("fp-zotero-highlights");
  // Track the currently-rendered "view" (search / pickAttach / annotations)
  // on the pane itself so closures don't leak across mode swaps.
  pane._zh = {
    appState,
    annotations: [],
    activeColor: null,    // null = "all"
    query: "",
  };

  if (pane.zotero?.attKey) {
    pane.fileName = pane.zotero.title || "Zotero highlights";
    setTitleText(pane, pane.fileName);
    await renderAnnotationsView(pane, /* fromCacheFirst */ true);
  } else {
    await renderSearchView(pane);
  }
}

// ── Title bar helpers ────────────────────────────────────────────────

function setTitleText(pane, text) {
  const link = pane.el?.querySelector(".fp-title-link");
  if (link) link.textContent = text;
}

// ── Mode 1: search ───────────────────────────────────────────────────

async function renderSearchView(pane) {
  const root = pane._content;
  root.innerHTML = "";
  root.classList.add("zh-mode-search");
  root.classList.remove("zh-mode-pick-attach", "zh-mode-annotations");

  const header = h("div", "zh-section-header", "Pick a reference to browse highlights");
  root.appendChild(header);

  const input = document.createElement("input");
  input.type = "text";
  input.className = "zh-search-input";
  input.placeholder = "Search Zotero library…";
  input.autocomplete = "off";
  root.appendChild(input);

  const list = h("div", "zh-result-list");
  root.appendChild(list);

  const status = h("div", "zh-status");
  root.appendChild(status);

  let refs = [];
  try {
    refs = (await loadReferences()) || [];
  } catch (e) {
    status.textContent = "Failed to load references: " + (e?.message || e);
    return;
  }
  if (refs.length === 0) {
    status.innerHTML = "No Zotero references found.<br>Set up credentials in Settings &gt; Zotero.";
    return;
  }

  function paint(query) {
    const results = fuzzySearch(refs, query);
    list.innerHTML = "";
    if (results.length === 0) {
      list.appendChild(h("div", "zh-empty", "No matches."));
      return;
    }
    for (const ref of results) {
      const row = document.createElement("div");
      row.className = "zh-result";
      const t = document.createElement("span");
      t.className = "zh-result-title";
      t.textContent = ref.shortTitle || ref.title || "Untitled";
      row.appendChild(t);
      const m = document.createElement("span");
      m.className = "zh-result-meta";
      const meta = [ref.year, ref.authors].filter(Boolean).join(" — ");
      if (meta) m.textContent = meta;
      row.appendChild(m);
      row.addEventListener("click", () => onPickItem(pane, ref));
      list.appendChild(row);
    }
  }

  input.addEventListener("input", () => paint(input.value));
  paint("");
  setTimeout(() => input.focus(), 0);
}

async function onPickItem(pane, ref) {
  const pdfAttachments = (ref.attachments || []).filter((a) => a.isPdf);
  if (pdfAttachments.length === 0) {
    const status = pane._content.querySelector(".zh-status");
    if (status) status.textContent = `"${ref.title}" has no PDF attachments.`;
    return;
  }
  if (pdfAttachments.length === 1) {
    await selectAttachment(pane, ref, pdfAttachments[0]);
    return;
  }
  renderPickAttachView(pane, ref, pdfAttachments);
}

// ── Mode 2: pick attachment ──────────────────────────────────────────

function renderPickAttachView(pane, ref, attachments) {
  const root = pane._content;
  root.innerHTML = "";
  root.classList.remove("zh-mode-search", "zh-mode-annotations");
  root.classList.add("zh-mode-pick-attach");

  root.appendChild(h("div", "zh-section-header", "Choose a PDF attachment"));

  const meta = h("div", "zh-detail-meta");
  meta.textContent = [ref.year, ref.authors].filter(Boolean).join(" — ");
  root.appendChild(h("div", "zh-detail-title", ref.title));
  root.appendChild(meta);

  const list = h("div", "zh-result-list");
  for (const att of attachments) {
    const row = document.createElement("div");
    row.className = "zh-result";
    const t = document.createElement("span");
    t.className = "zh-result-title";
    t.textContent = att.title || "PDF attachment";
    row.appendChild(t);
    row.addEventListener("click", () => selectAttachment(pane, ref, att));
    list.appendChild(row);
  }
  root.appendChild(list);

  const back = document.createElement("button");
  back.className = "zh-back-btn";
  back.textContent = "Back";
  back.addEventListener("click", () => renderSearchView(pane));
  root.appendChild(back);
}

// ── Mode 3: annotations ──────────────────────────────────────────────

async function selectAttachment(pane, ref, att) {
  pane.zotero = {
    itemKey: ref.key,
    attKey: att.key,
    title: ref.title || "Untitled",
    authors: ref.authors || "",
    year: ref.year || "",
  };
  pane.fileName = pane.zotero.title;
  setTitleText(pane, pane.fileName);
  schedulePersist();
  await renderAnnotationsView(pane, /* fromCacheFirst */ true);
}

async function renderAnnotationsView(pane, fromCacheFirst) {
  const root = pane._content;
  root.innerHTML = "";
  root.classList.remove("zh-mode-search", "zh-mode-pick-attach");
  root.classList.add("zh-mode-annotations");
  const z = pane.zotero;
  if (!z || !z.attKey) {
    return renderSearchView(pane);
  }

  // Header
  const header = document.createElement("div");
  header.className = "zh-header";
  const titleEl = document.createElement("a");
  titleEl.className = "zh-header-title";
  titleEl.href = pdfLink(z.attKey, 1);
  titleEl.textContent = z.title;
  attachExternalLinkHandler(titleEl);
  header.appendChild(titleEl);
  const meta = [z.authors, z.year].filter(Boolean).join(" — ");
  header.appendChild(h("div", "zh-header-meta", meta));
  const refreshBtn = document.createElement("button");
  refreshBtn.className = "zh-refresh-btn";
  refreshBtn.title = "Re-fetch annotations from Zotero";
  refreshBtn.textContent = "↻";
  refreshBtn.addEventListener("click", () => fetchAndPaint(pane, /* force */ true));
  header.appendChild(refreshBtn);
  root.appendChild(header);

  // Search bar
  const search = document.createElement("input");
  search.type = "text";
  search.className = "zh-annot-search";
  search.placeholder = "Search highlights…";
  search.autocomplete = "off";
  search.addEventListener("input", () => {
    pane._zh.query = search.value;
    paintAnnotations(pane);
  });
  root.appendChild(search);

  // Two-column body: colors + list
  const body = document.createElement("div");
  body.className = "zh-body";
  const colors = h("div", "zh-colors");
  const list = h("div", "zh-list");
  body.appendChild(colors);
  body.appendChild(list);
  root.appendChild(body);

  pane._zh.colorsEl = colors;
  pane._zh.listEl = list;
  pane._zh.searchEl = search;

  // Loading status
  const status = h("div", "zh-status", "Loading annotations…");
  root.appendChild(status);
  pane._zh.statusEl = status;

  await fetchAndPaint(pane, /* force */ !fromCacheFirst);
}

async function fetchAndPaint(pane, force) {
  // Re-entrancy guard: refresh-button mashing or rapid reload of the
  // pane shouldn't queue up overlapping network calls.
  if (pane._zh._fetching) return;
  pane._zh._fetching = true;
  const z = pane.zotero;
  const settings = pane._zh.appState?.settings || {};
  const userId = settings.zoteroUserId || "";
  const apiKey = settings.zoteroApiKey || "";
  if (!userId || !apiKey) {
    if (pane._zh.statusEl) {
      pane._zh.statusEl.textContent = "Zotero credentials missing — set them in Settings > Zotero.";
    }
    pane._zh._fetching = false;
    return;
  }
  if (pane._zh.statusEl) pane._zh.statusEl.textContent = force ? "Refreshing…" : "Loading…";
  try {
    const { annotations, fromCache } = await getAnnotations(z.attKey, userId, apiKey, {
      forceRefresh: !!force,
    });
    // Drop entries with no highlighted text (typically ink / image
    // annotations) — those don't surface usefully here and they pollute
    // the color swatches.
    pane._zh.annotations = annotations.filter((a) => (a.text || "").trim().length > 0);
    if (pane._zh.statusEl) {
      const noun = annotations.length === 1 ? "annotation" : "annotations";
      pane._zh.statusEl.textContent = `${annotations.length} ${noun}${fromCache ? " (cached)" : ""}`;
    }
    paintColors(pane);
    paintAnnotations(pane);
  } catch (e) {
    if (pane._zh.statusEl) {
      pane._zh.statusEl.textContent = "Failed: " + (e?.message || e);
    }
  } finally {
    pane._zh._fetching = false;
  }
}

function paintColors(pane) {
  const { annotations, activeColor } = pane._zh;
  const colorsEl = pane._zh.colorsEl;
  if (!colorsEl) return;
  colorsEl.innerHTML = "";
  const { colors } = groupByColor(annotations);

  // "All" swatch — empty circle, no fill. Distinguished from a missing
  // color by the dedicated zh-swatch-all class.
  const all = document.createElement("button");
  all.className = "zh-swatch zh-swatch-all" + (activeColor == null ? " active" : "");
  all.addEventListener("click", () => {
    pane._zh.activeColor = null;
    paintColors(pane);
    paintAnnotations(pane);
  });
  colorsEl.appendChild(all);

  for (const c of colors) {
    if (!c) continue;
    const sw = document.createElement("button");
    sw.className = "zh-swatch" + (activeColor === c ? " active" : "");
    sw.style.backgroundColor = c;
    sw.addEventListener("click", () => {
      pane._zh.activeColor = pane._zh.activeColor === c ? null : c;
      paintColors(pane);
      paintAnnotations(pane);
    });
    colorsEl.appendChild(sw);
  }
}

function paintAnnotations(pane) {
  const { annotations, activeColor, query } = pane._zh;
  const listEl = pane._zh.listEl;
  if (!listEl) return;
  const q = (query || "").trim().toLowerCase();

  const filtered = annotations.filter((a) => {
    if (activeColor != null && a.color !== activeColor) return false;
    if (!q) return true;
    const hay = `${a.text} ${a.comment} ${a.pageLabel} ${a.tags.join(" ")}`.toLowerCase();
    return hay.includes(q);
  });

  listEl.innerHTML = "";
  if (filtered.length === 0) {
    listEl.appendChild(h("div", "zh-empty", "No highlights match."));
    return;
  }
  for (const ann of filtered) {
    listEl.appendChild(buildAnnotationRow(pane, ann));
  }
}

function buildAnnotationRow(pane, ann) {
  const row = document.createElement("div");
  row.className = "zh-annot";
  if (ann.color) row.style.borderLeftColor = ann.color;
  row.dataset.key = ann.key;

  if (ann.text) {
    const t = h("div", "zh-annot-text", ann.text);
    row.appendChild(t);
  }
  if (ann.comment) {
    const c = h("div", "zh-annot-comment", ann.comment);
    row.appendChild(c);
  }
  // Meta row: the page label is a clickable Zotero link; type (if any)
  // follows as plain text.
  if (ann.pageLabel || (ann.type && ann.type !== "highlight")) {
    const metaRow = h("div", "zh-annot-meta");
    if (ann.pageLabel) {
      const pageLink = document.createElement("a");
      pageLink.className = "zh-annot-page";
      pageLink.href = pdfLink(pane.zotero.attKey, ann.pageLabel);
      pageLink.textContent = "p. " + ann.pageLabel;
      attachExternalLinkHandler(pageLink);
      metaRow.appendChild(pageLink);
    }
    if (ann.type && ann.type !== "highlight") {
      const typeBit = document.createElement("span");
      typeBit.textContent = (ann.pageLabel ? " · " : "") + ann.type;
      metaRow.appendChild(typeBit);
    }
    row.appendChild(metaRow);
  }

  // Drag-out: forward pointerdown into the existing text-drag pipeline so
  // the row lands in docs (markdown blockquote) or notebook canvases
  // (TextShape) the same way a regular shape drag would.
  row.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const text = formatAnnotationForDrop(pane.zotero, ann);
    startTextDrag({ text, initialEvent: e });
  });

  return row;
}

/** Build the markdown payload that gets dropped into a doc / notebook.
 *  Highlight body becomes a blockquote; the user's comment (if any)
 *  follows on its own line; a citation suffix anchors back to Zotero. */
function formatAnnotationForDrop(z, ann) {
  const body = (ann.text || "").trim();
  const comment = (ann.comment || "").trim();
  const pageBit = ann.pageLabel ? ` p.${ann.pageLabel}` : "";
  const link = pdfLink(z.attKey, ann.pageLabel || null);
  const title = z.title || "Untitled";
  const cite = `— [${title}${pageBit}](${link})`;

  const lines = [];
  if (body) {
    for (const ln of body.split(/\r?\n/)) {
      lines.push("> " + ln);
    }
  }
  if (comment) {
    if (lines.length) lines.push(">");
    for (const ln of comment.split(/\r?\n/)) {
      lines.push("> " + ln);
    }
  }
  lines.push("");
  lines.push(cite);
  return lines.join("\n");
}

/** zotero://open-pdf URL with optional page anchor. `page` may be the
 *  Zotero page label string or null. */
function pdfLink(attKey, page) {
  let url = `zotero://open-pdf/library/items/${attKey}`;
  if (page != null && page !== "") url += `?page=${encodeURIComponent(page)}`;
  return url;
}

/** Tauri webviews don't navigate plain `<a href>` anchors with custom
 *  schemes — they swallow the click. Hand the URL to the opener plugin
 *  instead (with a `window.open` fallback for browser dev). */
function attachExternalLinkHandler(anchor) {
  // Stop the parent row's pointerdown drag handler from kicking in.
  anchor.addEventListener("pointerdown", (e) => e.stopPropagation());
  anchor.addEventListener("click", async (e) => {
    e.preventDefault();
    e.stopPropagation();
    const url = anchor.href;
    try {
      const opener = await import("@tauri-apps/plugin-opener");
      await opener.openUrl(url);
    } catch {
      window.open(url, "_blank");
    }
  });
}

// ── Tiny DOM helper ──────────────────────────────────────────────────

function h(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text != null) el.textContent = text;
  return el;
}
