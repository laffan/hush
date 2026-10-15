/**
 * The text layer: pdf.js lays transparent, selectable text over the
 * raster where the words are, so a passage can be selected and copied —
 * on the pages, and on the folded view's folds. A scan's OCR text counts.
 *
 * Lines in a selection are joined with a space when it is copied: pdf.js
 * separates a text layer's lines with `<br>`, which the plain-text copy
 * of a selection drops, running the last word of one line into the
 * first of the next.
 */
import { getPdfjs } from "./pdfjs-loader.js";

/** Lay pdf.js's selectable text over a freshly rendered page. It joins
 *  the page's content box, so it stretches with the raster and is
 *  dropped with it on eviction. */
export async function attachTextLayer(p, page) {
  const host = p.contentEl;
  if (!host || !p.renderedZoom) return;
  await renderTextLayer(host, page, p.renderedZoom, () => p.contentEl === host);
}

/** The text layer itself, over `host` (a page drawn at `scale` CSS px
 *  per PDF unit) — a page's content box, or a fold of the folded view.
 *  `current` says whether `host` still shows this page once pdf.js has
 *  loaded. */
export async function renderTextLayer(host, page, scale, current = () => host.isConnected) {
  const { TextLayer } = await getPdfjs();
  if (!current()) return; // evicted or re-rendered meanwhile
  host.querySelector(".textLayer")?.remove();
  const div = document.createElement("div");
  div.className = "textLayer";
  div.style.setProperty("--total-scale-factor", String(scale));
  div.style.setProperty("--scale-round-x", "1px");
  div.style.setProperty("--scale-round-y", "1px");
  host.appendChild(div);
  try {
    await new TextLayer({
      textContentSource: page.streamTextContent(),
      container: div,
      viewport: page.getViewport({ scale }),
    }).render();
  } catch (_) {
    // A page with no usable text (a scan without OCR) simply isn't
    // selectable.
    div.remove();
  }
}

/** pdf.js's text layers share a few measuring canvases and a cache of
 *  font metrics across documents; with no viewer open, let them go. */
export async function releaseTextLayers() {
  try { (await getPdfjs()).TextLayer?.cleanup?.(); } catch (_) {}
}

/** Copy a selection inside `root`'s text layers as its words, each line
 *  joined to the next with a space. */
export function attachSelectionCopy(root) {
  root.addEventListener("copy", (e) => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !e.clipboardData) return;
    const range = sel.getRangeAt(0);
    const anchor = range.commonAncestorContainer;
    const el = anchor instanceof Element ? anchor : anchor?.parentElement;
    if (!el || !root.contains(el)) return;
    const frag = range.cloneContents();
    frag.querySelectorAll("br").forEach((br) => br.replaceWith(" "));
    const text = (frag.textContent || "").replace(/[ \t]+/g, " ").replace(/ ?\n ?/g, "\n").trim();
    if (!text) return;
    e.clipboardData.setData("text/plain", text);
    e.preventDefault();
  });
}
