/**
 * Three-way merge for a document edited in two places at once.
 *
 * A save now knows what its buffer was loaded from (the *base*), so when
 * the disk has moved on there are three texts to work with: the base,
 * this device's buffer (*mine*) and what the disk holds now (*theirs*).
 * Edits that don't touch the same stretch of the base merge by
 * themselves — which is the common case for a doc written on a laptop
 * and touched up on an iPad — and only edits that overlap need a person.
 *
 * Classic diff3 over lines first. Markdown prose keeps a whole paragraph
 * on one line, though, so two devices editing different sentences of the
 * same paragraph would collide at line level; an overlapping region gets
 * a second try at word granularity before it counts as a conflict.
 *
 * Pure functions, no app imports — so it can be exercised from node.
 */

/** Past this many DP cells a region is too big to align cheaply; the
 *  merge reports a conflict and the user decides. Same bound as the
 *  Versions diff (~2000 x 2000 lines). */
const MAX_CELLS = 4_000_000;

/** For each index of `a`, the index of `b` it is aligned with in a
 *  longest common subsequence (or -1). Null when the region between the
 *  common prefix and suffix is too big to align. */
function align(a, b) {
  const m = new Int32Array(a.length).fill(-1);
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) { m[pre] = pre; pre++; }
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre
    && a[a.length - 1 - suf] === b[b.length - 1 - suf]) {
    m[a.length - 1 - suf] = b.length - 1 - suf;
    suf++;
  }
  const rows = a.length - suf - pre;
  const cols = b.length - suf - pre;
  if (rows === 0 || cols === 0) return m;
  if ((rows + 1) * (cols + 1) > MAX_CELLS) return null;
  const w = cols + 1;
  const dp = new Int32Array((rows + 1) * w);
  for (let i = rows - 1; i >= 0; i--) {
    for (let j = cols - 1; j >= 0; j--) {
      dp[i * w + j] = a[pre + i] === b[pre + j]
        ? dp[(i + 1) * w + j + 1] + 1
        : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
    }
  }
  let i = 0;
  let j = 0;
  while (i < rows && j < cols) {
    if (a[pre + i] === b[pre + j]) { m[pre + i] = pre + j; i++; j++; }
    else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) i++;
    else j++;
  }
  return m;
}

function same(x, y) {
  if (x.length !== y.length) return false;
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  return true;
}

/** diff3 over token arrays. Returns `{ segments }` — a list of
 *  `{ ok: tokens }` and `{ base, mine, theirs }` (a conflict) — or null
 *  when a region was too big to align. */
function diff3(base, mine, theirs) {
  const toMine = align(base, mine);
  const toTheirs = align(base, theirs);
  if (!toMine || !toTheirs) return null;
  const segments = [];
  let i = 0;
  let j = 0;
  let k = 0;
  const settle = (bEnd, mEnd, tEnd) => {
    const b = base.slice(i, bEnd);
    const x = mine.slice(j, mEnd);
    const y = theirs.slice(k, tEnd);
    if (b.length === 0 && x.length === 0 && y.length === 0) return;
    if (same(x, b)) segments.push({ ok: y });
    else if (same(y, b) || same(x, y)) segments.push({ ok: x });
    else segments.push({ base: b, mine: x, theirs: y });
  };
  for (let s = 0; s < base.length; s++) {
    const js = toMine[s];
    const ks = toTheirs[s];
    // A line both sides kept is a fixed point; everything between two
    // fixed points is one region to settle.
    if (js < j || ks < k) continue;
    settle(s, js, ks);
    segments.push({ ok: [base[s]] });
    i = s + 1;
    j = js + 1;
    k = ks + 1;
  }
  settle(base.length, mine.length, theirs.length);
  return { segments };
}

const WORDS = /\s+|[^\s]+/g;

/** Retry an overlapping line region word by word. */
function mergeWords(base, mine, theirs) {
  const tok = (lines) => lines.join("\n").match(WORDS) || [];
  const res = diff3(tok(base), tok(mine), tok(theirs));
  if (!res || res.segments.some((s) => !s.ok)) return null;
  return res.segments.flatMap((s) => s.ok).join("").split("\n");
}

/**
 * Merge `mine` and `theirs`, both descended from `base`.
 * Returns `{ clean: true, text }`, or `{ clean: false, conflicts }` when
 * some region was changed differently on both sides.
 */
export function merge3(base, mine, theirs) {
  if (mine === theirs || theirs === base) return { clean: true, text: mine };
  if (mine === base) return { clean: true, text: theirs };
  const res = diff3(base.split("\n"), mine.split("\n"), theirs.split("\n"));
  if (!res) return { clean: false, conflicts: 1 };
  const out = [];
  let conflicts = 0;
  for (const seg of res.segments) {
    if (seg.ok) { out.push(...seg.ok); continue; }
    const words = mergeWords(seg.base, seg.mine, seg.theirs);
    if (words) out.push(...words);
    else conflicts++;
  }
  return conflicts ? { clean: false, conflicts } : { clean: true, text: out.join("\n") };
}

/**
 * The edits that turn `from` into `to`, as CodeMirror change specs in
 * `from`'s character offsets — one per changed run of lines, so a caret
 * sitting between two of them stays where it is instead of being swept
 * to the end of a single whole-range replacement.
 */
export function lineChanges(from, to) {
  const a = from.split("\n");
  const b = to.split("\n");
  const m = align(a, b);
  if (!m) return [{ from: 0, to: from.length, insert: to }];
  const offsets = [0];
  for (const line of a) offsets.push(offsets[offsets.length - 1] + line.length + 1);
  const changes = [];
  let i = 0;
  let j = 0;
  // Whole lines [i, iEnd) of `from` become lines [j, jEnd) of `to`. Mid-
  // document, each line owns its trailing newline. The tail region has
  // none to own, so it replaces up to the end, deletes the newline before
  // it, or appends after one, as the case needs.
  const flush = (iEnd, jEnd, tail) => {
    if (i === iEnd && j === jEnd) return;
    const lines = b.slice(j, jEnd);
    if (!tail) {
      changes.push({ from: offsets[i], to: offsets[iEnd], insert: lines.map((l) => l + "\n").join("") });
    } else if (i < iEnd && lines.length) {
      changes.push({ from: offsets[i], to: from.length, insert: lines.join("\n") });
    } else if (i < iEnd) {
      changes.push({ from: Math.max(0, offsets[i] - 1), to: from.length, insert: "" });
    } else {
      changes.push({ from: from.length, to: from.length, insert: "\n" + lines.join("\n") });
    }
  };
  for (let s = 0; s < a.length; s++) {
    if (m[s] < j) continue;
    flush(s, m[s], false);
    i = s + 1;
    j = m[s] + 1;
  }
  flush(a.length, b.length, true);
  return changes;
}
