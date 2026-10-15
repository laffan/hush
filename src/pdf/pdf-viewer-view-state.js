/**
 * A PDF's viewer state, kept per PDF on this device so it reopens as it
 * was left — on switching to another file and back, and between
 * sessions.
 *
 * The record (localStorage `hush_pdf_views`, keyed by fileId) has two
 * halves:
 *
 *  - **The PDF's own**, shared by every viewer showing it: the reading
 *    crop (pdf-viewer-crop.js) and the folded view's filter when it was
 *    changed by hand. A trim belongs to the document's margins, so a
 *    crop set in a pane is the crop the main viewer reads with too.
 *  - **The main viewer's view**: the layout (scroll direction, fit, the
 *    fixed view's sets, a fixed zoom), the folded view with its zoom,
 *    and the place — the first page in view and how far into it, or the
 *    first fold and how far into that. Panes and stack columns keep
 *    their own layout and scroll in their own records (the encoded
 *    zoom, `encodeZoom` below), so the main viewer's isn't theirs to
 *    overwrite.
 *
 * A PDF the main viewer has never shown opens in the layout last chosen
 * there (`hush_pdf_view_prefs`); without one, a portrait viewer (an iPad
 * upright) starts in vertical fit, since the horizontal default fits
 * pages to the height and crops them there. Nothing here is synced: it
 * is how this device reads, like the shelf width.
 */
import { sanitizeCrop } from "./pdf-viewer-crop.js";

const VIEWS_KEY = "hush_pdf_views";
const PREFS_KEY = "hush_pdf_view_prefs";
/** Records kept; the least recently used go first. */
const MAX_VIEWS = 400;

const LAYOUTS = ["horizontal", "vertical", "fixed"];
const FITS = ["fit", "fit-2", "fit-3"];

function readJson(key) {
  try { return JSON.parse(localStorage.getItem(key) || "null"); } catch (_) { return null; }
}
function writeJson(key, v) {
  try { localStorage.setItem(key, JSON.stringify(v)); } catch (_) { /* storage full / unavailable */ }
}

/** The stored record for `fileId`, or null. */
export function loadPdfView(fileId) {
  if (!fileId) return null;
  const all = readJson(VIEWS_KEY);
  const v = all && typeof all === "object" ? all[fileId] : null;
  if (!v || typeof v !== "object") return null;
  return {
    crop: sanitizeCrop(v.crop),
    foldFilter: Array.isArray(v.foldFilter) ? v.foldFilter.filter((k) => typeof k === "string") : null,
    main: v.main && typeof v.main === "object" && LAYOUTS.includes(v.main.layoutMode) ? v.main : null,
  };
}

/** Merge `patch` (`crop`, `foldFilter`, `main`) into `fileId`'s record. */
export function savePdfView(fileId, patch) {
  if (!fileId) return;
  const all = readJson(VIEWS_KEY) || {};
  all[fileId] = { ...(all[fileId] || {}), ...patch, t: Date.now() };
  const ids = Object.keys(all);
  if (ids.length > MAX_VIEWS) {
    ids.sort((a, b) => (all[a]?.t || 0) - (all[b]?.t || 0));
    for (const id of ids.slice(0, ids.length - MAX_VIEWS)) delete all[id];
  }
  writeJson(VIEWS_KEY, all);
}

/** The layout last chosen in the main viewer. */
export function loadViewPrefs() {
  const v = readJson(PREFS_KEY);
  return v && LAYOUTS.includes(v.layoutMode) ? v : null;
}
export function saveViewPrefs(v) {
  writeJson(PREFS_KEY, v);
}

/** The layout a viewer starts in: its saved one, else (main viewer) the
 *  last chosen, else vertical fit on a portrait viewer and horizontal
 *  otherwise. */
export function initialLayout(saved, prefs, portrait) {
  const base = saved || prefs;
  const folded = !!saved?.folded;
  return {
    // Folding shows the pages top to bottom at one page's width.
    layoutMode: folded ? "vertical" : (LAYOUTS.includes(base?.layoutMode) ? base.layoutMode : (portrait ? "vertical" : "horizontal")),
    fitMode: folded ? "fit" : (FITS.includes(base?.fitMode) ? base.fitMode : "fit"),
    fixedZoom: Number(base?.fixedZoom) > 0 ? Number(base.fixedZoom) : 1,
    paged: !!base?.paged,
    folded,
    foldedZoom: Number(saved?.foldedZoom) > 0 ? Number(saved.foldedZoom) : 1,
  };
}

// ── The encoded zoom (panes, stack columns, suspend / resume) ─────────
// Hosts persist a viewer's layout as one number: positive for a fixed
// zoom, negative for the fit modes — -1 vertical fit, -2 horizontal,
// -3 / -4 vertical fit 2 / 3, -5 folded — and, for the paged view,
// -11 / -12 / -13 (top to bottom, 1–3 pages a set) and -21 / -22 / -23
// (side by side). An unknown code reads as horizontal fit.

const FIT_OF = { 1: "fit", 2: "fit-2", 3: "fit-3" };

export function encodeZoom(s) {
  if (s.folded) return -5;
  const n = s.fitMode === "fit-3" ? 3 : s.fitMode === "fit-2" ? 2 : 1;
  if (s.paged && s.layoutMode !== "fixed") return (s.layoutMode === "horizontal" ? -20 : -10) - n;
  if (s.layoutMode === "horizontal") return -2;
  if (s.layoutMode === "vertical") return n === 3 ? -4 : n === 2 ? -3 : -1;
  return s.fixedZoom;
}

/** The layout an encoded zoom names. */
export function decodeZoom(level) {
  if (level === -5) return { folded: true, layoutMode: "vertical", fitMode: "fit", paged: false };
  const base = { folded: false, paged: false };
  if (level === -1) return { ...base, layoutMode: "vertical", fitMode: "fit" };
  if (level === -3) return { ...base, layoutMode: "vertical", fitMode: "fit-2" };
  if (level === -4) return { ...base, layoutMode: "vertical", fitMode: "fit-3" };
  if (level <= -11 && level >= -13) return { ...base, paged: true, layoutMode: "vertical", fitMode: FIT_OF[-10 - level] };
  if (level <= -21 && level >= -23) return { ...base, paged: true, layoutMode: "horizontal", fitMode: FIT_OF[-20 - level] };
  if (level > 0) return { ...base, layoutMode: "fixed", fixedZoom: level };
  return { ...base, layoutMode: "horizontal", fitMode: "fit" };
}

/** Report the view a moment after it settles (scrolling changes it
 *  every frame); `flush` reports a change still waiting at once — as
 *  does the app going to the background, where iPadOS may end it. */
export function createViewReporter(capture, report) {
  let timer = 0;
  const emit = () => {
    clearTimeout(timer);
    timer = 0;
    const v = capture();
    if (v) report(v);
  };
  const flush = () => { if (timer) emit(); };
  const onHidden = () => { if (document.visibilityState === "hidden") flush(); };
  document.addEventListener("visibilitychange", onHidden);
  return {
    changed: () => {
      clearTimeout(timer);
      timer = setTimeout(emit, 400);
    },
    flush,
    /** Report what is waiting, and stop listening. */
    dispose: () => {
      flush();
      document.removeEventListener("visibilitychange", onHidden);
    },
  };
}
