/**
 * Outlines in a Doc — the frontmatter switch, and the list→outline
 * conversion the command palette runs.
 *
 * A Doc has no per-block metadata channel the way a notebook shape does,
 * so an outline says so in the document itself: `outline: true` in the
 * frontmatter turns every nested checklist in that doc into an outline.
 * The two footer toggles ride the same channel (`outlineHideDone`, and
 * `outlinePin` naming which outline is pinned), which is what makes them
 * survive a reload, travel with the file into a synced desk folder, and
 * mean the same thing on another device — none of which a per-session
 * flag would do.
 *
 * Every write here is a **line-level splice inside the block**, never a
 * parse-and-reserialize. Re-serializing would be the shorter code and
 * would quietly rewrite the user's other properties on the way past
 * (quoting, list style, comment placement); splicing one line leaves the
 * rest of the YAML byte-identical, and works on a block the properties
 * model can't represent at all.
 */

import { findFrontmatterRange, FRONTMATTER_SCAN_LIMIT } from "./frontmatter.js";
import { propertiesEdit } from "./plugins/properties.js";
import {
  addCheckboxes, removeCheckboxes, isListLine, isPlainListLine, parseOutlineLine,
} from "../outline/outline-model.ts";

/** Keys this module owns. */
export const OUTLINE_KEY = "outline";
export const HIDE_DONE_KEY = "outlineHideDone";
export const PIN_KEY = "outlinePin";

/** Slice the head of a CodeMirror doc — frontmatter never lives past the
 *  scan limit, and stringifying a long doc per keystroke would hurt. */
export function docHead(doc) {
  return doc.sliceString(0, Math.min(doc.length, FRONTMATTER_SCAN_LIMIT));
}

/** Read one top-level `key: value` out of a frontmatter block. Returns
 *  the raw (trimmed) value string, or null when the key isn't there. */
function readKey(head, key) {
  const fm = findFrontmatterRange(head);
  if (!fm) return null;
  const body = head.slice(fm.contentFrom, fm.contentTo);
  for (const line of body.split("\n")) {
    if (/^\s/.test(line)) continue; // nested — not ours
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    if (line.slice(0, idx).trim() !== key) continue;
    return line.slice(idx + 1).trim();
  }
  return null;
}

/** YAML-ish truthiness, unquoted only. A quoted `"true"` is the Text
 *  property type in Hush's properties model, so honouring it here would
 *  make the switch disagree with the UI that shows it. */
function isTrue(raw) {
  return raw === "true";
}

/**
 * The outline settings a document carries.
 * `pin` is the 1-based index of the pinned outline block (0 = none):
 * only one outline can hold the bottom of the frame at a time, and an
 * index is the smallest thing that can say which — `true` is accepted
 * as "the first one" so a hand-written doc does the obvious thing.
 */
export function readOutlineFlags(head) {
  const on = isTrue(readKey(head, OUTLINE_KEY));
  if (!on) return { on: false, hideDone: false, pin: 0 };
  const rawPin = readKey(head, PIN_KEY);
  let pin = 0;
  if (rawPin != null) {
    if (isTrue(rawPin)) pin = 1;
    else if (/^\d+$/.test(rawPin)) pin = parseInt(rawPin, 10);
  }
  return { on: true, hideDone: isTrue(readKey(head, HIDE_DONE_KEY)), pin };
}

/** Convenience for callers holding a CodeMirror state. */
export function outlineFlagsOf(edState) {
  return readOutlineFlags(docHead(edState.doc));
}

/**
 * Build the change specs that set (or, for a null value, remove) each
 * `key` in `patch` inside the doc's frontmatter, creating the block when
 * the doc has none. Returns an array of `{from, to, insert}` in
 * ascending order; empty when nothing needs to move.
 */
export function frontmatterPatchChanges(edState, patch) {
  const head = docHead(edState.doc);
  const fm = findFrontmatterRange(head);
  const entries = Object.entries(patch).filter(([, v]) => v !== undefined);
  if (entries.length === 0) return [];

  if (!fm) {
    const lines = entries.filter(([, v]) => v !== null).map(([k, v]) => `${k}: ${v}`);
    if (lines.length === 0) return [];
    return [{ from: 0, to: 0, insert: `---\n${lines.join("\n")}\n---\n` }];
  }

  // Walk the block's lines once, recording each owned key's span so a
  // set becomes a replace and a remove becomes a delete-with-newline.
  const spans = new Map();
  let pos = fm.contentFrom;
  const body = head.slice(fm.contentFrom, fm.contentTo);
  for (const line of body.split("\n")) {
    const lineStart = pos;
    pos += line.length + 1;
    if (/^\s/.test(line)) continue;
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim();
    if (key in patch && !spans.has(key)) spans.set(key, { from: lineStart, to: lineStart + line.length });
  }

  const changes = [];
  const appends = [];
  for (const [key, value] of entries) {
    const span = spans.get(key);
    if (value === null) {
      // Take the line's newline with it, or an empty line is left behind.
      if (span) changes.push({ from: span.from, to: Math.min(edState.doc.length, span.to + 1), insert: "" });
    } else if (span) {
      // A no-op rewrite would still be an edit — a dirty flag, an undo
      // step and a sync push for a value that didn't change.
      const next = `${key}: ${value}`;
      if (edState.doc.sliceString(span.from, span.to) !== next) {
        changes.push({ from: span.from, to: span.to, insert: next });
      }
    } else {
      appends.push(`${key}: ${value}`);
    }
  }
  // New keys land just before the closing delimiter, so the order the
  // user put their own properties in is untouched.
  if (appends.length) changes.push({ from: fm.contentTo, to: fm.contentTo, insert: appends.join("\n") + "\n" });
  changes.sort((a, b) => a.from - b.from);
  return changes;
}

/** Apply a frontmatter patch to `view` as one undoable edit. */
export function patchOutlineFrontmatter(view, patch) {
  const changes = frontmatterPatchChanges(view.state, patch);
  if (!changes.length) return false;
  // The properties plugin guards the block against stray edits; this is
  // the UI that owns it, so it says so rather than being filtered out.
  view.dispatch({ changes, annotations: propertiesEdit.of(true) });
  return true;
}

/**
 * The list block a "Convert to Outline" would act on: the run of list
 * lines the selection touches, when at least one of them still lacks a
 * checkbox. Returns `{ fromLine, toLine }` (1-based CodeMirror line
 * numbers) or null.
 *
 * A run that is already all checkboxes is not a target — there is
 * nothing left to convert, and offering the command would suggest
 * otherwise.
 */
export function listBlockForSelection(edState) {
  const doc = edState.doc;
  const sel = edState.selection.main;
  const startLine = doc.lineAt(sel.from).number;
  const endLine = doc.lineAt(sel.to).number;

  // Anchor on the first list line the selection touches; a cursor
  // parked just past a list still means that list.
  let anchor = 0;
  for (let n = startLine; n <= endLine; n++) {
    if (isListLine(doc.line(n).text)) { anchor = n; break; }
  }
  if (!anchor && isListLine(doc.line(startLine).text)) anchor = startLine;
  if (!anchor) return null;

  let fromLine = anchor;
  while (fromLine > 1 && isListLine(doc.line(fromLine - 1).text)) fromLine--;
  let toLine = anchor;
  while (toLine < doc.lines && isListLine(doc.line(toLine + 1).text)) toLine++;

  let hasPlain = false;
  for (let n = fromLine; n <= toLine; n++) {
    if (isPlainListLine(doc.line(n).text)) { hasPlain = true; break; }
  }
  if (!hasPlain) return null;
  return { fromLine, toLine };
}

/**
 * "Convert to Outline" for a Doc: give every item in the selected list a
 * checkbox and turn the document's outline switch on — in one
 * transaction, so one undo puts the document back exactly as it was.
 */
export function convertListToOutline(view) {
  const block = listBlockForSelection(view.state);
  if (!block) return false;
  const doc = view.state.doc;
  const lines = [];
  for (let n = block.fromLine; n <= block.toLine; n++) lines.push(doc.line(n).text);
  const rewritten = addCheckboxes(lines);

  const changes = frontmatterPatchChanges(view.state, { [OUTLINE_KEY]: "true" });
  const from = doc.line(block.fromLine).from;
  const to = doc.line(block.toLine).to;
  changes.push({ from, to, insert: rewritten.join("\n") });
  changes.sort((a, b) => a.from - b.from);
  view.dispatch({ changes, annotations: propertiesEdit.of(true) });
  return true;
}

/**
 * The outline block a "Convert to List" would act on: the run of
 * checklist lines the selection touches. Returns `{ fromLine, toLine }`
 * (1-based CodeMirror line numbers) or null.
 *
 * The mirror of `listBlockForSelection`, and deliberately not its
 * opposite in gating: a run of checkboxes is a target whether or not the
 * document's outline switch happens to be on, because taking the boxes
 * off is what the command says it does either way.
 */
export function outlineBlockForSelection(edState) {
  const doc = edState.doc;
  const sel = edState.selection.main;
  const startLine = doc.lineAt(sel.from).number;
  const endLine = doc.lineAt(sel.to).number;

  let anchor = 0;
  for (let n = startLine; n <= endLine; n++) {
    if (parseOutlineLine(doc.line(n).text)) { anchor = n; break; }
  }
  if (!anchor) return null;

  let fromLine = anchor;
  while (fromLine > 1 && parseOutlineLine(doc.line(fromLine - 1).text)) fromLine--;
  let toLine = anchor;
  while (toLine < doc.lines && parseOutlineLine(doc.line(toLine + 1).text)) toLine++;
  return { fromLine, toLine };
}

/**
 * "Convert to List" for a Doc — the inverse of `convertListToOutline`:
 * take the checkboxes off the outline under the caret, leaving a plain
 * bulleted list.
 *
 * The frontmatter switch only comes off when this was the *last*
 * checklist in the document. `outline: true` is a document-wide switch,
 * so clearing it while another outline is still in the file would turn
 * that one into a bare checklist the user never touched — and the two
 * footer toggles, which ride the same block, go with it.
 */
export function convertOutlineToList(view) {
  const block = outlineBlockForSelection(view.state);
  if (!block) return false;
  const doc = view.state.doc;
  const lines = [];
  for (let n = block.fromLine; n <= block.toLine; n++) lines.push(doc.line(n).text);
  const rewritten = removeCheckboxes(lines);

  let lastOne = true;
  for (let n = 1; n <= doc.lines && lastOne; n++) {
    if (n >= block.fromLine && n <= block.toLine) continue;
    if (parseOutlineLine(doc.line(n).text)) lastOne = false;
  }

  const changes = lastOne
    ? frontmatterPatchChanges(view.state, {
      [OUTLINE_KEY]: null, [HIDE_DONE_KEY]: null, [PIN_KEY]: null,
    })
    : [];
  const from = doc.line(block.fromLine).from;
  const to = doc.line(block.toLine).to;
  changes.push({ from, to, insert: rewritten.join("\n") });
  changes.sort((a, b) => a.from - b.from);
  view.dispatch({ changes, annotations: propertiesEdit.of(true) });
  return true;
}

/**
 * Flip the document's `outline: true` switch — the whole of "Outline
 * mode". Turning it off takes the two footer toggles with it: they are
 * an outline's own state, and leaving them behind in a document with no
 * outlines would mean a stale pin index applying to whatever checklist
 * the switch was next turned on over.
 */
export function toggleOutlineMode(view) {
  const on = readOutlineFlags(docHead(view.state.doc)).on;
  return patchOutlineFrontmatter(view, on
    ? { [OUTLINE_KEY]: null, [HIDE_DONE_KEY]: null, [PIN_KEY]: null }
    : { [OUTLINE_KEY]: "true" });
}
