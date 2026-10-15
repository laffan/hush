/**
 * Find in the PDF — the search behind the viewer's find bar
 * (pdf-viewer-find-bar.js).
 *
 * Each page's text comes from pdf.js's text content (a scan's OCR layer
 * included), read once per document and kept. Hits are drawn as boxes
 * in an overlay on the page wrapper, positioned in percentages of the
 * page, so they need no rendered raster, survive eviction and follow
 * every zoom. Pages are searched in order and the count grows as they
 * are read, so a long book shows its first hits at once. A query is
 * case-insensitive, and any run of spaces in it matches any whitespace
 * (a phrase broken across lines is still one phrase).
 */

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Characters of context before and after a match — about three lines'
 *  in the results list, which clamps to three. The shorter lead-in keeps
 *  the match itself within the first two. */
const BEFORE = 60;
const AFTER = 130;

const squash = (t) => t.replace(/\s+/g, " ");

/** The match in `text` at [from, to) with its context, cut at word
 *  boundaries and marked with an ellipsis where the page goes on. */
function summarize(text, from, to, page) {
  let a = Math.max(0, from - BEFORE);
  let b = Math.min(text.length, to + AFTER);
  if (a > 0) a = Math.min(from, text.indexOf(" ", a) + 1 || a);
  if (b < text.length) b = Math.max(to, text.lastIndexOf(" ", b) === -1 ? b : text.lastIndexOf(" ", b));
  return {
    page: page + 1,
    before: (a > 0 ? "…" : "") + squash(text.slice(a, from)).trimStart(),
    match: squash(text.slice(from, to)),
    after: squash(text.slice(to, b)).trimEnd() + (b < text.length ? "…" : ""),
  };
}

function applyTransform(m, x, y) {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

/**
 * @param {object} env
 * @param {function} env.getPdfDoc   () => pdfjs doc | null
 * @param {function} env.getPages    () => pages[]
 * @param {function} env.reveal      (pageIndex, x, y) => void — bring a hit into view
 *                                   (its position on the page, 0–1)
 * @param {function} env.isDestroyed () => boolean
 */
export function createPdfSearch(env) {
  const texts = new Map();
  let hits = [];      // { page (0-based), rects: [{x, y, w, h}] as page fractions }
  let summaries = []; // { page (1-based), before, match, after }
  let current = -1;
  let query = "";
  let token = 0;
  let listener = null;
  let done = true;

  async function pageText(i) {
    const cached = texts.get(i);
    if (cached) return cached;
    const doc = env.getPdfDoc();
    if (!doc) return null;
    const page = await doc.getPage(i + 1);
    const vp = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    const items = content.items.filter((it) => typeof it.str === "string");
    let text = "";
    const starts = [];
    for (const it of items) {
      starts.push(text.length);
      text += it.str;
      // Line ends become spaces, so a phrase broken across lines is
      // still one phrase.
      if (it.hasEOL && !/\s$/.test(it.str)) text += " ";
    }
    const pt = { text, items, starts, width: vp.width, height: vp.height, transform: vp.transform };
    texts.set(i, pt);
    return pt;
  }

  /** The item holding character `pos`: the last one starting at or before it. */
  function itemAt(pt, pos) {
    let lo = 0;
    let hi = pt.starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (pt.starts[mid] <= pos) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  /** Boxes for characters [from, to) of a page — one per text item the
   *  match runs through, the item's width shared out by character. */
  function rectsFor(pt, from, to) {
    const out = [];
    for (let k = itemAt(pt, from); k < pt.items.length && pt.starts[k] < to; k++) {
      const it = pt.items[k];
      const len = it.str.length;
      if (!len) continue;
      const a = Math.max(0, from - pt.starts[k]) / len;
      const b = Math.min(len, to - pt.starts[k]) / len;
      if (b <= a) continue;
      const [ta, tb, tc, td, tx, ty] = it.transform;
      // Along the baseline, in the item's own direction.
      const dirX = Math.hypot(ta, tb) || 1;
      const ux = ta / dirX;
      const uy = tb / dirX;
      const fontH = it.height || Math.hypot(tc, td);
      const corners = [
        [tx + ux * it.width * a, ty + uy * it.width * a],
        [tx + ux * it.width * b, ty + uy * it.width * b],
      ].flatMap(([x, y]) => [
        // A little below the baseline for descenders, up to the cap.
        applyTransform(pt.transform, x + uy * fontH * 0.22, y - ux * fontH * 0.22),
        applyTransform(pt.transform, x - uy * fontH * 0.98, y + ux * fontH * 0.98),
      ]);
      const xs = corners.map((c) => c[0]);
      const ys = corners.map((c) => c[1]);
      const x0 = Math.min(...xs);
      const y0 = Math.min(...ys);
      out.push({
        x: x0 / pt.width,
        y: y0 / pt.height,
        w: (Math.max(...xs) - x0) / pt.width,
        h: (Math.max(...ys) - y0) / pt.height,
      });
    }
    return out;
  }

  function status() {
    return { query, hits: summaries.slice(), total: hits.length, current: current + 1, done };
  }
  const notify = () => listener?.(status());

  function clearOverlays() {
    for (const p of env.getPages()) p.wrapper.querySelector(".pdf-search-hits")?.remove();
  }

  function paintPage(page) {
    const wrapper = env.getPages()[page]?.wrapper;
    if (!wrapper) return;
    wrapper.querySelector(".pdf-search-hits")?.remove();
    const layer = document.createElement("div");
    layer.className = "pdf-search-hits";
    hits.forEach((h, idx) => {
      if (h.page !== page) return;
      for (const r of h.rects) {
        const box = document.createElement("div");
        box.className = idx === current ? "pdf-search-hit current" : "pdf-search-hit";
        box.style.left = `${r.x * 100}%`;
        box.style.top = `${r.y * 100}%`;
        box.style.width = `${r.w * 100}%`;
        box.style.height = `${r.h * 100}%`;
        layer.appendChild(box);
      }
    });
    if (layer.childElementCount) wrapper.appendChild(layer);
  }

  function select(idx, reveal = true) {
    const prev = hits[current]?.page;
    current = idx;
    const hit = hits[idx];
    if (prev != null && prev !== hit?.page) paintPage(prev);
    if (!hit) { notify(); return; }
    paintPage(hit.page);
    const r = hit.rects[0];
    if (reveal) env.reveal(hit.page, r ? r.x + r.w / 2 : 0.5, r ? r.y + r.h / 2 : 0);
    notify();
  }

  /** Search for `q`. The first hit is shown as soon as it is found. */
  async function search(q) {
    const my = ++token;
    query = (q || "").trim();
    hits = [];
    summaries = [];
    current = -1;
    clearOverlays();
    const doc = env.getPdfDoc();
    if (!query) { done = true; notify(); return; }
    // Typed before the PDF finished opening: left pending ("…") and run
    // by rerun() once the document is there.
    done = false;
    notify();
    if (!doc) return;
    const re = new RegExp(query.split(/\s+/).map(escapeRe).join("\\s+"), "gi");
    for (let i = 0; i < doc.numPages; i++) {
      const pt = await pageText(i).catch(() => null);
      if (my !== token || env.isDestroyed()) return;
      if (!pt) continue;
      let found = false;
      for (const m of pt.text.matchAll(re)) {
        if (!m[0]) continue;
        const from = m.index ?? 0;
        const to = from + m[0].length;
        hits.push({ page: i, rects: rectsFor(pt, from, to) });
        summaries.push(summarize(pt.text, from, to, i));
        found = true;
      }
      if (found) {
        paintPage(i);
        if (current < 0) select(0);
        else notify();
      }
    }
    done = true;
    notify();
  }

  /** Move to the next (1) or previous (-1) hit, wrapping round. */
  function step(dir) {
    if (!hits.length) return;
    select((current + dir + hits.length) % hits.length);
  }

  /** Show hit `idx` (0-based) — a click in the results list. */
  function goTo(idx) {
    if (idx >= 0 && idx < hits.length) select(idx);
  }

  /** Search again for the current query — after the document (re)loads,
   *  whose pages, and so whose hit boxes, are new. */
  function rerun() {
    texts.clear();
    if (query) search(query);
  }

  return {
    search,
    step,
    goTo,
    rerun,
    clear: () => search(""),
    query: () => query,
    onChange: (fn) => { listener = fn; },
  };
}
