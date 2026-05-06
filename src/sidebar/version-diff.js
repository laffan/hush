/**
 * Line-level diff for the Versions panel.
 *
 * Returns an array of `{ type: "context" | "added" | "removed", text }`
 * entries reconstructing the path from `oldText` to `newText`. Uses a
 * standard LCS table with common-prefix / common-suffix trimming so the
 * usual "edited a paragraph in the middle of a long doc" case stays
 * cheap.
 */

const MAX_LCS_CELLS = 4_000_000; // ~16 MB Int32Array; ~2000x2000 lines

export function diffLines(oldText, newText) {
  const a = (oldText || "").split("\n");
  const b = (newText || "").split("\n");

  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;

  let suffix = 0;
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) {
    suffix++;
  }

  const aMid = a.slice(prefix, a.length - suffix);
  const bMid = b.slice(prefix, b.length - suffix);

  const out = [];
  for (let i = 0; i < prefix; i++) out.push({ type: "context", text: a[i] });
  for (const entry of lcsDiff(aMid, bMid)) out.push(entry);
  for (let i = a.length - suffix; i < a.length; i++) out.push({ type: "context", text: a[i] });
  return out;
}

function lcsDiff(a, b) {
  const m = a.length;
  const n = b.length;

  if (m === 0 && n === 0) return [];
  if (m === 0) return b.map((text) => ({ type: "added", text }));
  if (n === 0) return a.map((text) => ({ type: "removed", text }));

  // Pathological case: fall back to "all removed, then all added".
  if ((m + 1) * (n + 1) > MAX_LCS_CELLS) {
    return [
      ...a.map((text) => ({ type: "removed", text })),
      ...b.map((text) => ({ type: "added", text })),
    ];
  }

  const w = n + 1;
  const dp = new Int32Array((m + 1) * w);
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      if (a[i] === b[j]) {
        dp[i * w + j] = dp[(i + 1) * w + (j + 1)] + 1;
      } else {
        const down = dp[(i + 1) * w + j];
        const right = dp[i * w + (j + 1)];
        dp[i * w + j] = down >= right ? down : right;
      }
    }
  }

  const out = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      out.push({ type: "context", text: a[i] });
      i++;
      j++;
    } else if (dp[(i + 1) * w + j] >= dp[i * w + (j + 1)]) {
      out.push({ type: "removed", text: a[i++] });
    } else {
      out.push({ type: "added", text: b[j++] });
    }
  }
  while (i < m) out.push({ type: "removed", text: a[i++] });
  while (j < n) out.push({ type: "added", text: b[j++] });
  return out;
}
