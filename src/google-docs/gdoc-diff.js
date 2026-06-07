/**
 * Pure paragraph-level diff between a live Google Doc and the markdown
 * Hush wants to push — the engine behind incremental (non-destructive)
 * push. No CodeMirror / Tauri / network imports, so it's unit-testable in
 * isolation (see `scripts`-style node harness used during development).
 *
 * Why paragraphs: Google's text model is a flat stream where each
 * paragraph ends in `\n`, and comments/suggestions/formatting are anchored
 * to character ranges. If we rewrite the whole body (the old media-upload
 * push), every anchor dies and all formatting resets. By diffing at the
 * paragraph level and touching only the paragraphs that actually changed,
 * untouched paragraphs — and the comments + styling on them — survive.
 *
 * Strategy:
 *   1. Project the markdown to the plain-text paragraphs Google would hold
 *      (`projectToParagraphs`) and read the Google Doc's paragraphs with
 *      their character indices (`readGoogleParagraphs`).
 *   2. LCS-align the two by whitespace-normalised text (`computeParagraphOps`)
 *      so unchanged paragraphs become no-ops; gaps pair up as in-place
 *      modifications, with leftovers as inserts/deletes.
 *   3. Emit minimal Docs API `batchUpdate` requests (`buildBatchRequests`),
 *      using a common-prefix/suffix char diff inside a modified paragraph
 *      so even a comment anchored mid-paragraph (outside the edited run)
 *      is preserved.
 *
 * `computeParagraphOps` takes an optional `baseParas` argument — the seam
 * for a future 3-way merge (phase 3) that distinguishes "user deleted X"
 * from "someone added X in Google". It's unused for now (2-way: make
 * Google match desired), so push is last-writer-wins per paragraph.
 */
import { stripCommentSyntax } from "../editor/comment-syntax.js";

// Markdown features we can't yet map to Google indices safely. When any
// are present the caller falls back to the whole-document push.
export function hasUnsupportedMarkdown(md) {
  const s = stripCommentSyntax(String(md || ""));
  return (
    /\[\^/.test(s) ||                                  // footnotes
    /!\[[^\]]*\]\(/.test(s) ||                          // images
    /^\s*```/m.test(s) ||                               // code fences
    /^\s*\|.*\|\s*$/m.test(s) ||                        // tables
    /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/m.test(s)           // thematic breaks
  );
}

/** Strip inline markdown to the bare text Google stores in its runs. */
function stripInline(s) {
  return String(s)
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__)(.*?)\1/g, "$2")
    .replace(/(\*|_)([^*_]+?)\1/g, "$2")
    .replace(/~~(.*?)~~/g, "$1")
    .replace(/==(.*?)==/g, "$1");
}

/**
 * Project markdown to the ordered list of plain-text paragraphs Google
 * would represent it as: one paragraph per heading, list item, block-quote
 * line, and hard-wrapped prose block. Comment scaffolding is stripped.
 */
export function projectToParagraphs(md) {
  // Drop Google-comment scaffolding and Hush's own `%%author notes%%`
  // (which the legacy HTML push also stripped) — neither belongs in the
  // Google Doc body, and including them would diff as spurious inserts.
  const text = stripCommentSyntax(String(md || "")).replace(/%%[\s\S]*?%%/g, "");
  const lines = text.split("\n");
  const paras = [];
  let buf = [];
  const flush = () => {
    if (!buf.length) return;
    const t = stripInline(buf.join(" ")).trim();
    if (t) paras.push(t);
    buf = [];
  };
  const push = (raw) => {
    const t = stripInline(raw).trim();
    if (t) paras.push(t);
  };
  for (const line of lines) {
    if (line.trim() === "") { flush(); continue; }
    let m;
    if ((m = /^#{1,6}\s+(.*)$/.exec(line))) { flush(); push(m[1]); continue; }
    if ((m = /^\s*>\s?(.*)$/.exec(line))) { flush(); push(m[1]); continue; }
    if ((m = /^\s*(?:[-*+]|\d+\.)\s+(.*)$/.exec(line))) { flush(); push(m[1]); continue; }
    buf.push(line.trim());
  }
  flush();
  return paras;
}

/**
 * Read a Google `documentTab` body into `{ text, start, end, empty }`
 * paragraphs (indices are the tab-local character positions used by
 * `batchUpdate`). `unsupported` is set when the body contains structures
 * we can't safely index around (tables, footnote refs, inline objects).
 */
export function readGoogleParagraphs(documentTab) {
  const content = documentTab?.body?.content || [];
  const paras = [];
  let endIndex = 1;
  let unsupported = false;
  for (const elem of content) {
    if (typeof elem.endIndex === "number") endIndex = elem.endIndex;
    if (elem.table || elem.tableOfContents) { unsupported = true; continue; }
    if (!elem.paragraph) continue; // sectionBreak etc.
    let text = "";
    for (const pe of elem.paragraph.elements || []) {
      if (pe.textRun) text += pe.textRun.content || "";
      else if (pe.footnoteReference || pe.inlineObjectElement || pe.person
        || pe.richLink || pe.horizontalRule) unsupported = true;
    }
    text = text.replace(/\n$/, "");
    paras.push({ text, start: elem.startIndex || 0, end: elem.endIndex, empty: text.trim() === "" });
  }
  return { paras, endIndex, unsupported };
}

function normalize(s) {
  return String(s).replace(/\s+/g, " ").trim();
}

/**
 * Align Google's content paragraphs with the desired paragraphs and emit
 * keep / modify / insert / delete ops. Empty Google paragraphs (spacing)
 * are never matched or deleted — they're left untouched.
 */
export function computeParagraphOps(googleParas, desiredParas, baseParas = null) {
  void baseParas; // phase-3 seam (3-way merge); unused in the 2-way path
  const g = googleParas.filter((p) => !p.empty);
  const d = desiredParas.slice();
  const gn = g.map((p) => normalize(p.text));
  const dn = d.map((s) => normalize(s));
  const n = g.length;
  const m = d.length;

  // LCS table (suffix form).
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = gn[i] === dn[j]
        ? dp[i + 1][j + 1] + 1
        : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const ops = [];
  let dels = [];
  let inss = [];
  const flushGap = (anchor) => {
    const k = Math.min(dels.length, inss.length);
    for (let x = 0; x < k; x++) ops.push({ type: "modify", gPara: dels[x], desiredText: inss[x] });
    for (let x = k; x < dels.length; x++) ops.push({ type: "delete", gPara: dels[x] });
    for (let x = k; x < inss.length; x++) ops.push({ type: "insert", desiredText: inss[x], anchor });
    dels = [];
    inss = [];
  };

  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (gn[i] === dn[j]) {
      flushGap(g[i].start);
      ops.push({ type: "keep" });
      i++; j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      dels.push(g[i]); i++;
    } else {
      inss.push(d[j]); j++;
    }
  }
  while (i < n) { dels.push(g[i]); i++; }
  while (j < m) { inss.push(d[j]); j++; }
  flushGap(null); // trailing gap → append at document end
  return ops;
}

/**
 * Turn ops into Docs API `batchUpdate` requests. Requests are ordered
 * high-index → low-index so each edit leaves the indices of later (lower)
 * edits untouched; at equal index, deletes precede inserts.
 */
export function buildBatchRequests(ops, tabId, docEndIndex) {
  const loc = (index) => (tabId ? { tabId, index } : { index });
  const rng = (startIndex, endIndex) =>
    (tabId ? { tabId, startIndex, endIndex } : { startIndex, endIndex });

  // Merge consecutive inserts at the same anchor so their order survives.
  const merged = [];
  for (const op of ops) {
    const last = merged[merged.length - 1];
    if (op.type === "insert" && last && last.type === "insert" && last.anchor === op.anchor) {
      last.desiredText += "\n" + op.desiredText;
    } else {
      merged.push({ ...op });
    }
  }

  const entries = [];
  for (const op of merged) {
    if (op.type === "delete") {
      entries.push({ index: op.gPara.start, order: 0, req: { deleteContentRange: { range: rng(op.gPara.start, op.gPara.end) } } });
    } else if (op.type === "modify") {
      const a = op.gPara.text;
      const b = op.desiredText;
      let pre = 0;
      const maxPre = Math.min(a.length, b.length);
      while (pre < maxPre && a[pre] === b[pre]) pre++;
      let suf = 0;
      const maxSuf = Math.min(a.length - pre, b.length - pre);
      while (suf < maxSuf && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
      const delStart = op.gPara.start + pre;
      const delEnd = op.gPara.start + (a.length - suf);
      const insText = b.slice(pre, b.length - suf);
      if (delEnd > delStart) entries.push({ index: delStart, order: 0, req: { deleteContentRange: { range: rng(delStart, delEnd) } } });
      if (insText) entries.push({ index: delStart, order: 1, req: { insertText: { location: loc(delStart), text: insText } } });
    } else if (op.type === "insert") {
      if (op.anchor != null) {
        entries.push({ index: op.anchor, order: 1, req: { insertText: { location: loc(op.anchor), text: op.desiredText + "\n" } } });
      } else {
        const at = Math.max(1, docEndIndex - 1);
        entries.push({ index: at, order: 2, req: { insertText: { location: loc(at), text: "\n" + op.desiredText } } });
      }
    }
  }

  entries.sort((x, y) => (y.index - x.index) || (x.order - y.order));
  return entries.map((e) => e.req);
}
