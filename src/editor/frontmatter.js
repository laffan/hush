/**
 * Metadata frontmatter ("Properties") — parse / serialize core.
 *
 * A document carries properties when it *starts* with a `---` line and a
 * closing `---` (or `...`) line follows within the head of the file, with
 * only simple YAML between: `key: value` scalars, block lists (`- item`),
 * inline lists (`[a, b]`), blank lines, and `#` comments. This mirrors
 * Obsidian's Properties feature: anything more exotic (nested maps,
 * multiline scalars) is NOT treated as frontmatter and renders as plain
 * text, so no data can be silently rewritten by the properties UI.
 *
 * The parsed model is a list of entries:
 *   { type: "text",     key, value: string }
 *   { type: "number",   key, value: string }   — kept as the raw digits
 *   { type: "checkbox", key, value: boolean }
 *   { type: "date",     key, value: string }   — YYYY-MM-DD
 *   { type: "datetime", key, value: string }   — YYYY-MM-DDTHH:MM(:SS)
 *   { type: "list",     key, value: string[] }
 *   { type: "tags",     key, value: string[] } — the `tags` key, list-shaped
 *   { type: "comment",  text }                 — `# …` preserved verbatim
 *
 * Types are inferred Obsidian-style: unquoted scalars that look like a
 * number / date / datetime / boolean get the matching type; quoting a
 * value pins it to text. The `tags` key is always the Tags type.
 *
 * `serializeProperties` round-trips that model back to a `---` block.
 */

// Scalar-type detection for unquoted values. Exported for the widget's
// type-conversion logic so both sides agree on what "looks like" each type.
export const NUMBER_RE = /^-?(\d+\.?\d*|\.\d+)$/;
export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const DATETIME_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?$/;

/** True when `key` gets the Tags treatment (Obsidian: the `tags` key). */
export function isTagsKey(key) {
  return String(key || "").trim().toLowerCase() === "tags";
}

// Only scan the head of the doc for a closing delimiter — a lone `---`
// horizontal rule deep in a long doc must not swallow everything above
// it into "frontmatter".
export const FRONTMATTER_SCAN_LIMIT = 10000;

/**
 * Locate the frontmatter block at the very start of `text`.
 * Returns `{ from: 0, to, contentFrom, contentTo }` or null.
 * `to` is the end of the closing delimiter line (before its newline);
 * `contentFrom`/`contentTo` bound the YAML between the delimiters.
 */
export function findFrontmatterRange(text) {
  if (!text.startsWith("---")) return null;
  const firstLineEnd = text.indexOf("\n");
  if (firstLineEnd === -1) return null;
  if (text.slice(0, firstLineEnd).trimEnd() !== "---") return null;
  let lineStart = firstLineEnd + 1;
  const limit = Math.min(text.length, FRONTMATTER_SCAN_LIMIT);
  while (lineStart <= limit) {
    const nl = text.indexOf("\n", lineStart);
    const lineEnd = nl === -1 ? text.length : nl;
    const line = text.slice(lineStart, lineEnd).trimEnd();
    if (line === "---" || line === "...") {
      return {
        from: 0,
        to: lineEnd,
        contentFrom: firstLineEnd + 1,
        contentTo: lineStart,
      };
    }
    if (nl === -1) break;
    lineStart = nl + 1;
  }
  return null;
}

/** Strip a leading frontmatter block (delimiters included, plus the
 *  newline that follows the closing line). Used by first-line naming and
 *  anywhere else that wants "the document body". */
export function stripFrontmatter(text) {
  const range = findFrontmatterRange(text);
  if (!range) return text;
  let end = range.to;
  if (text.charCodeAt(end) === 10 /* \n */) end++;
  return text.slice(end);
}

/** Unquote a scalar. Returns { value, quoted }. */
function parseScalar(raw) {
  const s = raw.trim();
  if (s.length >= 2) {
    const q = s[0];
    if ((q === '"' || q === "'") && s[s.length - 1] === q) {
      const inner = s.slice(1, -1);
      return {
        value: q === '"' ? inner.replace(/\\"/g, '"') : inner.replace(/''/g, "'"),
        quoted: true,
      };
    }
  }
  return { value: s, quoted: false };
}

/** Split an inline list body (`a, "b, c", d`) on top-level commas. */
function splitInlineList(body) {
  const items = [];
  let cur = "";
  let quote = null;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (quote) {
      cur += ch;
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
    } else if (ch === ",") {
      items.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  items.push(cur);
  return items.map((s) => s.trim()).filter((s) => s !== "");
}

// A property key: starts with a word-ish character, then anything that
// isn't a colon. Rejects lines like `:foo` or `- bar` posing as keys.
const KEY_RE = /^([A-Za-z0-9_][^:]*):(.*)$/;

/**
 * Parse the YAML between the delimiters into the entries model.
 * Returns an array of entries, or null when a line falls outside the
 * supported subset (signalling "this is not a properties block").
 */
export function parseProperties(content) {
  const entries = [];
  let pendingListOwner = null; // last `key:` seen with no inline value
  for (const rawLine of content.split("\n")) {
    if (!rawLine.trim()) { pendingListOwner = null; continue; }
    const trimmed = rawLine.trim();
    if (trimmed.startsWith("#")) {
      entries.push({ type: "comment", text: rawLine });
      continue;
    }
    // List item — only valid while collecting under a `key:` line.
    if (/^[-]\s/.test(trimmed) || trimmed === "-") {
      if (!pendingListOwner) return null;
      if (pendingListOwner.type !== "list" && pendingListOwner.type !== "tags") {
        pendingListOwner.type = isTagsKey(pendingListOwner.key) ? "tags" : "list";
        pendingListOwner.value = [];
      }
      const item = trimmed === "-" ? "" : trimmed.slice(1).trim();
      pendingListOwner.value.push(parseScalar(item).value);
      continue;
    }
    // Anything indented that isn't a list item (nested maps, folded
    // scalars) is outside the supported subset.
    if (/^\s/.test(rawLine)) return null;
    const m = KEY_RE.exec(rawLine);
    if (!m) return null;
    const key = m[1].trim();
    const rest = m[2].trim();
    if (!key) return null;
    if (rest === "") {
      // Either an empty value or a block list header — list items on
      // following lines upgrade it. A bare `tags:` is an empty Tags list.
      const entry = isTagsKey(key)
        ? { type: "tags", key, value: [] }
        : { type: "text", key, value: "" };
      entries.push(entry);
      pendingListOwner = entry;
      continue;
    }
    pendingListOwner = null;
    if (rest.startsWith("[") && rest.endsWith("]")) {
      entries.push({
        type: isTagsKey(key) ? "tags" : "list",
        key,
        value: splitInlineList(rest.slice(1, -1)).map((s) => parseScalar(s).value),
      });
      continue;
    }
    const { value, quoted } = parseScalar(rest);
    if (isTagsKey(key)) {
      entries.push({ type: "tags", key, value: [value] });
      continue;
    }
    if (!quoted) {
      if (value === "true" || value === "false") {
        entries.push({ type: "checkbox", key, value: value === "true" });
        continue;
      }
      if (NUMBER_RE.test(value)) {
        entries.push({ type: "number", key, value });
        continue;
      }
      if (DATE_RE.test(value)) {
        entries.push({ type: "date", key, value });
        continue;
      }
      if (DATETIME_RE.test(value)) {
        entries.push({ type: "datetime", key, value: value.replace(" ", "T") });
        continue;
      }
    }
    entries.push({ type: "text", key, value });
  }
  return entries;
}

/** Quote a scalar when plain YAML would mangle or retype it — including
 *  values that would re-infer as number / date / datetime / boolean, so
 *  a Text property stays Text on the next parse. */
function serializeScalar(value) {
  const s = String(value ?? "");
  if (s === "") return '""';
  const needsQuote =
    /^[\s]|[\s]$/.test(s)
    || /^[-?:#&*!|>'"%@`[\]{},]/.test(s)
    || s.includes(": ")
    || s.endsWith(":")
    || s.includes(" #")
    || /^(true|false|null|yes|no|on|off)$/i.test(s)
    || NUMBER_RE.test(s)
    || DATE_RE.test(s)
    || DATETIME_RE.test(s);
  if (!needsQuote) return s;
  return '"' + s.replace(/"/g, '\\"') + '"';
}

/** Serialize a typed scalar (number / date / datetime) unquoted when it
 *  still matches its type's shape, else fall back to text quoting. */
function serializeTyped(value, re) {
  const s = String(value ?? "").trim();
  return re.test(s) ? s : serializeScalar(s);
}

/**
 * Serialize entries back to a full frontmatter block (delimiters
 * included, no trailing newline). Empty/keyless text rows are dropped;
 * an empty entry list returns "" (meaning: remove the block).
 */
export function serializeProperties(entries) {
  const lines = [];
  for (const e of entries || []) {
    if (e.type === "comment") { lines.push(e.text); continue; }
    const key = (e.key || "").trim();
    if (!key) continue;
    if (e.type === "list" || e.type === "tags") {
      const items = (e.value || []).filter((v) => String(v).trim() !== "");
      if (items.length === 0) {
        lines.push(`${key}: []`);
      } else {
        lines.push(`${key}:`);
        for (const item of items) lines.push(`  - ${serializeScalar(item)}`);
      }
    } else if (e.type === "checkbox") {
      lines.push(`${key}: ${e.value ? "true" : "false"}`);
    } else if (e.type === "number" || e.type === "date" || e.type === "datetime") {
      const re = e.type === "number" ? NUMBER_RE : e.type === "date" ? DATE_RE : DATETIME_RE;
      const v = String(e.value ?? "").trim();
      lines.push(v === "" ? `${key}:` : `${key}: ${serializeTyped(v, re)}`);
    } else {
      const v = String(e.value ?? "");
      lines.push(v === "" ? `${key}:` : `${key}: ${serializeScalar(v)}`);
    }
  }
  if (lines.length === 0) return "";
  return ["---", ...lines, "---"].join("\n");
}

/**
 * Convenience: find + parse in one step against a document head slice.
 * Returns `{ from, to, text, entries }` when the doc starts with a
 * parseable properties block, else null. `docHead` only needs to cover
 * the first FRONTMATTER_SCAN_LIMIT characters.
 */
export function getFrontmatter(docHead) {
  const range = findFrontmatterRange(docHead);
  if (!range) return null;
  const entries = parseProperties(docHead.slice(range.contentFrom, range.contentTo));
  if (!entries) return null;
  return { ...range, text: docHead.slice(range.from, range.to), entries };
}
