/**
 * Extract Annotations — rebuild, from a PDF file alone, the annotation
 * list the Zotero API would have handed the viewer.
 *
 * A Zotero annotation lives in two places. In the library it is a child
 * item of the attachment, which is what `zotero-annotations.js` fetches;
 * in a PDF exported from Zotero ("Export PDF…", "Save As" with
 * annotations, or a copy shared by someone else) it is written into the
 * file as an ordinary PDF annotation. A PDF imported from disk or the
 * clipboard (pdf-manual-import.js) may carry them only the second way,
 * and with no API to ask, the shelf stays empty though the marks are on
 * the page.
 *
 * This reads those annotations through pdf.js and reshapes each into the
 * raw item the API returns — `{ key, data: { annotationType,
 * annotationText, annotationComment, annotationColor,
 * annotationPageLabel, annotationSortIndex, annotationPosition, tags,
 * dateModified } }` — so everything downstream (the shelf, the folded
 * view, thumbnails, the highlight browser's grouping) takes it as it
 * takes Zotero's. Each item also carries `hushEmbedded: true`: pdf.js
 * already paints a file's own annotations into the page canvas, so the
 * overlay must not paint them a second time.
 *
 * What maps to what:
 *
 *   Highlight → highlight      Underline / StrikeOut / Squiggly → underline
 *   Text (sticky note) → note  FreeText → text
 *   Ink → ink                  Square → image (Zotero writes its image
 *                              annotations as a Square)
 *
 * Highlighted text is pdf.js's `overlaidText` when it offers it (5.x
 * does, for text-markup annotations); otherwise the page's text items
 * whose boxes fall inside the annotation's quads. Zotero writes its own
 * item key into the annotation (`/NM (Zotero-KEY)`, `/Zotero:Key`) and
 * the tags as JSON (`/Zotero:Tags`); pdf.js exposes neither, so they are
 * read straight off the file bytes when the file names Zotero at all.
 * Recovering the key is what lets a list fetched later from the API
 * recognise the same annotation instead of painting it twice.
 *
 * Generic on purpose: nothing below requires the file to come from
 * Zotero, so any annotated PDF (Preview, Acrobat, Skim) yields the same
 * shape — only the Zotero keys and tags are Zotero's.
 */

const SKIP_SUBTYPES = new Set(["Link", "Widget", "Popup"]);
const TYPE_BY_SUBTYPE = {
  Highlight: "highlight",
  Underline: "underline",
  StrikeOut: "underline",
  Squiggly: "underline",
  Text: "note",
  FreeText: "text",
  Ink: "ink",
  Square: "image",
};

const pad = (n, w) => String(Math.max(0, Math.floor(n))).padStart(w, "0");

function hexColor(rgb) {
  if (!rgb || rgb.length < 3) return "";
  return "#" + Array.from(rgb).slice(0, 3)
    .map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0"))
    .join("");
}

/** `D:20261001180859Z00'00'` → ISO 8601 (or "" when unreadable). */
function pdfDateToIso(s) {
  const m = /^D?:?(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?([Z+-])?(\d{2})?'?(\d{2})?/.exec(s || "");
  if (!m) return "";
  const [, y, mo = "01", d = "01", h = "00", mi = "00", se = "00", tz, th = "00", tm = "00"] = m;
  const offset = !tz || tz === "Z" ? "Z" : `${tz}${th}:${tm}`;
  const date = new Date(`${y}-${mo}-${d}T${h}:${mi}:${se}${offset}`);
  return isNaN(date) ? "" : date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** pdf.js hands quads over flat (8 numbers each) in 5.x and as arrays of
 *  `{x, y}` in older builds; either becomes `[x1, y1, x2, y2]` boxes. */
function quadRects(quadPoints) {
  if (!quadPoints) return [];
  const flat = [];
  for (const q of quadPoints) {
    if (typeof q === "number") flat.push(q);
    else if (Array.isArray(q)) for (const p of q) flat.push(p.x, p.y);
    else if (q && typeof q.x === "number") flat.push(q.x, q.y);
  }
  const rects = [];
  for (let i = 0; i + 7 < flat.length; i += 8) {
    const xs = [flat[i], flat[i + 2], flat[i + 4], flat[i + 6]];
    const ys = [flat[i + 1], flat[i + 3], flat[i + 5], flat[i + 7]];
    rects.push([Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)].map(round3));
  }
  return rects;
}

function inkPaths(inkLists) {
  const paths = [];
  for (const list of inkLists || []) {
    const flat = [];
    for (const p of list) {
      if (typeof p === "number") flat.push(round3(p));
      else if (p && typeof p.x === "number") flat.push(round3(p.x), round3(p.y));
    }
    if (flat.length >= 4) paths.push(flat);
  }
  return paths;
}

const round3 = (n) => Math.round(n * 1000) / 1000;

/** Text under `rects`, in reading order: each page text run whose
 *  vertical centre sits in a rect contributes the share of its
 *  characters the rect covers horizontally (a run is often a whole line,
 *  and a highlight half of one). Glyph widths are taken as even across
 *  the run, so the cut can land a character off; it is the fallback for
 *  a pdf.js build that doesn't fill `overlaidText`. */
function textUnderRects(textItems, rects) {
  const parts = [];
  for (const it of textItems) {
    const str = it.str || "";
    if (!str) continue;
    const [, , , d, x, y] = it.transform;
    const h = it.height || Math.abs(d) || 0;
    const w = it.width || 0;
    const cy = y + h / 2;
    for (const [x1, y1, x2, y2] of rects) {
      if (cy < y1 || cy > y2) continue;
      const from = Math.max(x, x1);
      const to = Math.min(x + w, x2);
      if (to <= from) continue;
      const a = w ? Math.round(((from - x) / w) * str.length) : 0;
      const b = w ? Math.round(((to - x) / w) * str.length) : str.length;
      const piece = str.slice(a, b).trim();
      if (piece) parts.push(piece);
      break;
    }
  }
  return parts.join(" ");
}

/** The way Zotero stores highlighted text: one line, words that a line
 *  break hyphenated joined back up. */
function tidyText(s) {
  return (s || "")
    .replace(/-\s*\n\s*/g, "")
    .replace(/\s*\n\s*/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** Characters on the page before the annotation's top-left, in reading
 *  order — the middle field of Zotero's sort index. */
function charOffsetBefore(textItems, top, left) {
  let n = 0;
  for (const it of textItems) {
    const [, , , , x, y] = it.transform;
    const above = y > top + 0.5;
    const sameLineLeft = Math.abs(y - top) <= 0.5 && x < left;
    if (above || sameLineLeft) n += (it.str || "").length;
  }
  return n;
}

// ── Zotero's own keys, off the raw bytes ──────────────────────────────

/** Read a PDF literal string `(…)` starting at `i` (the opening paren). */
function readLiteral(src, i) {
  let depth = 0, out = "";
  for (let j = i; j < src.length; j++) {
    const c = src[j];
    if (c === "\\") {
      const n = src[++j];
      const esc = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f" }[n];
      if (esc) out += esc;
      else if (/[0-7]/.test(n)) {
        let oct = n;
        while (oct.length < 3 && /[0-7]/.test(src[j + 1])) oct += src[++j];
        out += String.fromCharCode(parseInt(oct, 8));
      } else if (n !== "\n" && n !== "\r") out += n;
      continue;
    }
    if (c === "(") { if (depth++ > 0) out += c; continue; }
    if (c === ")") { if (--depth === 0) return out; out += c; continue; }
    out += c;
  }
  return null;
}

function readStringValue(dict, name) {
  const at = dict.indexOf(name);
  if (at < 0) return null;
  let i = at + name.length;
  while (i < dict.length && /\s/.test(dict[i])) i++;
  if (dict[i] === "(") return readLiteral(dict, i);
  if (dict[i] === "<" && dict[i + 1] !== "<") {
    const end = dict.indexOf(">", i);
    const hex = dict.slice(i + 1, end).replace(/\s+/g, "");
    let s = "";
    for (let k = 0; k + 1 < hex.length; k += 2) s += String.fromCharCode(parseInt(hex.slice(k, k + 2), 16));
    return s;
  }
  return null;
}

/** `{ "<objNum>R": { key, tags } }` for every annotation object Zotero
 *  named. Only uncompressed objects can be read this way, which is how
 *  Zotero writes them (an incremental update appended to the file). */
function zoteroKeysFromBytes(bytes) {
  const out = {};
  if (!bytes?.length) return out;
  let src;
  try { src = new TextDecoder("latin1").decode(bytes); } catch { return out; }
  if (!src.includes("Zotero")) return out;
  const re = /(\d+)\s+(\d+)\s+obj\b/g;
  let m;
  while ((m = re.exec(src))) {
    const end = src.indexOf("endobj", re.lastIndex);
    if (end < 0) break;
    const body = src.slice(re.lastIndex, end);
    if (body.includes("/Annot")) {
      const nm = readStringValue(body, "/NM");
      const key = readStringValue(body, "/Zotero:Key")
        || (nm && /^Zotero-([A-Z0-9]{8})$/.exec(nm)?.[1]) || null;
      if (key) {
        let tags = [];
        const rawTags = readStringValue(body, "/Zotero:Tags");
        if (rawTags) {
          try { tags = JSON.parse(rawTags).filter((t) => typeof t === "string"); } catch { /* not JSON */ }
        }
        const id = m[2] === "0" ? `${m[1]}R` : `${m[1]}R${m[2]}`;
        out[id] = { key, tags };
      }
    }
    re.lastIndex = end;
  }
  return out;
}

// ── The extraction ────────────────────────────────────────────────────

/**
 * Every annotation in `pdfDoc` as a raw Zotero-shaped item, in page
 * order. `opts.parentKey` (the Zotero attachment key, when the file has
 * one) is recorded as each item's `parentItem`.
 */
export async function extractPdfAnnotations(pdfDoc, opts = {}) {
  if (!pdfDoc) return [];
  let bytes = null;
  try { bytes = await pdfDoc.getData(); } catch { /* keys stay synthetic */ }
  const zoteroKeys = zoteroKeysFromBytes(bytes);
  let labels = null;
  try { labels = await pdfDoc.getPageLabels(); } catch { /* numbers it is */ }

  const items = [];
  for (let pageIndex = 0; pageIndex < pdfDoc.numPages; pageIndex++) {
    const page = await pdfDoc.getPage(pageIndex + 1);
    const annots = await page.getAnnotations({ intent: "display" });
    const marked = annots.filter((a) => !SKIP_SUBTYPES.has(a.subtype) && TYPE_BY_SUBTYPE[a.subtype]);
    if (!marked.length) continue;
    let textItems = [];
    try { textItems = (await page.getTextContent()).items || []; } catch { /* no text layer */ }
    const [, , , pageTop] = page.view || [0, 0, 0, 0];

    for (const a of marked) {
      const type = TYPE_BY_SUBTYPE[a.subtype];
      const rect = (a.rect || [0, 0, 0, 0]).map(round3);
      const zot = zoteroKeys[a.id] || null;
      const contents = a.contentsObj?.str || "";
      let position;
      let text = "";
      let comment = contents;
      if (type === "ink") {
        position = { pageIndex, width: a.borderStyle?.width || 1, paths: inkPaths(a.inkLists) };
      } else {
        const rects = quadRects(a.quadPoints);
        position = { pageIndex, rects: rects.length ? rects : [rect] };
        if (type === "highlight" || type === "underline") {
          text = tidyText(a.overlaidText || textUnderRects(textItems, position.rects));
        }
        if (type === "text") {
          position.fontSize = a.defaultAppearanceData?.fontSize || undefined;
          position.rotation = a.rotation || 0;
          if (!comment && Array.isArray(a.textContent)) comment = a.textContent.join("\n");
        }
      }
      const color = hexColor(a.color) || hexColor(a.defaultAppearanceData?.fontColor) || "#ffd400";
      const top = rect[3];
      const sortIndex = `${pad(pageIndex, 5)}|${pad(charOffsetBefore(textItems, top, rect[0]), 6)}|${pad(pageTop - top, 5)}`;
      const key = zot?.key || `P${a.id || items.length}`;
      items.push({
        key,
        version: 0,
        data: {
          key,
          itemType: "annotation",
          parentItem: opts.parentKey || "",
          annotationType: type,
          annotationText: text,
          annotationComment: comment,
          annotationColor: color,
          annotationPageLabel: labels?.[pageIndex] || String(pageIndex + 1),
          annotationSortIndex: sortIndex,
          annotationPosition: JSON.stringify(position),
          tags: (zot?.tags || []).map((tag) => ({ tag })),
          dateModified: pdfDateToIso(a.modificationDate),
          hushEmbedded: true,
        },
      });
    }
  }
  return items;
}
