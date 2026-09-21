/**
 * Outlines in a Doc — the CodeMirror half.
 *
 * With `outline: true` in the frontmatter, every nested checklist in the
 * document becomes an outline: a bordered block set a couple of pixels
 * smaller than the prose, in the app's UI font rather than the style's,
 * with completed items struck through and the first unfinished item bold
 * in the style's header colour. A footer under the block carries the two
 * toggles — hide completed, pin to bottom.
 *
 * The lines stay real document lines, so an outline is typed into like
 * any other list and the existing checkbox widget (`checkbox-list.js`)
 * already owns its boxes. Only two things replace text:
 *
 *   - **Hidden completed items.** A checked line collapses together with
 *     the newline in front of it, the way the properties block does, and
 *     is left alone while a cursor or selection touches it — hiding the
 *     line the caret is on would strand it.
 *   - **A pinned outline.** The block collapses to a small pill and is
 *     redrawn by the panel below, because CodeMirror only renders the
 *     lines near the scroll position: a `position: sticky` line, or a
 *     widget left in the document, is simply not in the DOM once the
 *     user scrolls away from it — which is the one thing a pinned
 *     outline must survive.
 *
 * Both replacements are atomic, so the cursor steps over them instead of
 * parking inside text nothing is drawing.
 */

import { Decoration, EditorView, ViewPlugin, WidgetType, keymap } from "@codemirror/view";
import { Prec, RangeSet, StateField } from "@codemirror/state";
import { firstOpenIndex, parseOutlineLine, toggleChecklistLine } from "../../outline/outline-model.ts";
import {
  HIDE_DONE_KEY, PIN_KEY, outlineFlagsOf, frontmatterPatchChanges,
} from "../outline-frontmatter.js";
import { propertiesEdit } from "./properties.js";
import { buildOutlineFooter, buildOutlineRows, buildOutlineZenStrip } from "../outline-dom.js";

/**
 * Every outline block in the document, as runs of consecutive checklist
 * lines carrying their own document offsets.
 *
 * Walks `iterLines` rather than calling `doc.line(n)` per line: this runs
 * on every document change in an outline doc, and the per-line lookup
 * turns that into a tree descent per line on a long file.
 */
function scanBlocks(doc) {
  const blocks = [];
  let cur = null;
  let pos = 0;
  let n = 0;
  for (const text of doc.iterLines()) {
    n += 1;
    const item = parseOutlineLine(text, n);
    if (item) {
      item.from = pos;
      item.to = pos + text.length;
      // The bullet itself, for the decoration that fades it out. The
      // first non-space character of a checklist line is always the
      // marker (`CHECK_RE` requires it), so no second parse is needed.
      const indent = text.length - text.trimStart().length;
      item.markFrom = pos + indent;
      item.markTo = item.markFrom + 1;
      if (cur) { cur.items.push(item); cur.toLine = n; }
      else cur = { fromLine: n, toLine: n, items: [item] };
    } else if (cur) { blocks.push(cur); cur = null; }
    pos += text.length + 1;
  }
  if (cur) blocks.push(cur);
  return blocks;
}

/** A stable identity for a block, so widgets survive unrelated edits. */
function blockSignature(block, flags, pinned) {
  return `${block.fromLine}:${pinned ? 1 : 0}:${flags.hideDone ? 1 : 0}:`
    + block.items.map((i) => (i.checked ? "x" : "o")).join("")
    + "|" + block.items.map((i) => i.text).join("\u0000");
}

/** Write one of the footer's flags into the frontmatter. */
function patchFlags(view, patch) {
  const changes = frontmatterPatchChanges(view.state, patch);
  if (!changes.length) return;
  view.dispatch({ changes, annotations: propertiesEdit.of(true) });
}

/**
 * Flip one checklist line, addressed by its line NUMBER rather than by
 * the offsets the panel was built from. The panel only rebuilds when a
 * block's signature changes, so an edit elsewhere in the document can
 * shift every offset under it without the rows noticing — a line number
 * survives that, and the parse below refuses anything that has stopped
 * being a checklist item in the meantime.
 */
function toggleAt(view, lineNumber) {
  const doc = view.state.doc;
  if (lineNumber < 1 || lineNumber > doc.lines) return;
  const line = doc.line(lineNumber);
  const next = toggleChecklistLine(line.text);
  if (next == null) return;
  view.dispatch({ changes: { from: line.from, to: line.to, insert: next } });
}

class OutlineFooterWidget extends WidgetType {
  constructor(sig, items, flags, blockIndex, capped) {
    super();
    this.sig = sig;
    this.items = items;
    this.flags = flags;
    this.blockIndex = blockIndex;
    // Every item hidden: the footer is the whole outline, so it closes
    // the box on all four sides rather than three.
    this.capped = capped;
  }

  eq(other) { return other.sig === this.sig && other.blockIndex === this.blockIndex; }

  toDOM(view) {
    const host = document.createElement("div");
    host.className = "cm-outline-footer-host" + (this.capped ? " cm-outline-footer-capped" : "");
    host.appendChild(buildOutlineFooter({
      hideDone: this.flags.hideDone,
      pinned: false,
      onToggleHideDone: () => patchFlags(view, { [HIDE_DONE_KEY]: this.flags.hideDone ? null : "true" }),
      onTogglePin: () => patchFlags(view, { [PIN_KEY]: String(this.blockIndex + 1) }),
    }));
    return host;
  }

  ignoreEvent() { return true; }
}

/** What a pinned outline leaves behind in the text: a pill saying where
 *  it went, and a way back. Without it the block would simply be missing
 *  from the document with nothing to explain the gap. */
class OutlinePinnedPillWidget extends WidgetType {
  constructor(sig, count) { super(); this.sig = sig; this.count = count; }

  eq(other) { return other.sig === this.sig; }

  toDOM(view) {
    const pill = document.createElement("span");
    pill.className = "cm-outline-pill";
    pill.textContent = `Outline pinned · ${this.count} item${this.count === 1 ? "" : "s"}`;
    pill.title = "Unpin outline";
    pill.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      patchFlags(view, { [PIN_KEY]: null });
    });
    return pill;
  }

  ignoreEvent() { return true; }
}

/** The bullet before a checkbox, painted at zero opacity. */
const dashDeco = Decoration.mark({ class: "cm-outline-dash" });

/** Does any cursor or selection range touch this span? */
function selectionTouches(edState, from, to) {
  for (const r of edState.selection.ranges) {
    if (Math.max(r.from, r.to) >= from && Math.min(r.from, r.to) <= to) return true;
  }
  return false;
}

/** Build the decoration set plus the subset the cursor must step over.
 *  One pass produces both: the atomic set is exactly the replacements,
 *  never the line decorations, whose zero-length ranges would make the
 *  caret skip lines that are perfectly visible. */
function buildOutlineState(edState) {
  const flags = outlineFlagsOf(edState);
  const empty = { deco: Decoration.none, atomic: RangeSet.empty, hideDone: false, pin: 0, pinnedBlock: null, blocks: [] };
  if (!flags.on) return empty;
  const doc = edState.doc;
  const blocks = scanBlocks(doc);
  if (!blocks.length) return { ...empty, hideDone: flags.hideDone, pin: flags.pin };

  const ranges = [];
  const atomics = [];
  blocks.forEach((block, bi) => {
    const pinned = flags.pin === bi + 1;
    const sig = blockSignature(block, flags, pinned);

    if (pinned) {
      const from = block.items[0].from;
      const to = block.items[block.items.length - 1].to;
      const deco = Decoration.replace({ widget: new OutlinePinnedPillWidget(sig, block.items.length) });
      ranges.push(deco.range(from, to));
      atomics.push(deco.range(from, to));
      return;
    }

    const nextIdx = firstOpenIndex(block.items);
    let first = true;
    block.items.forEach((item, i) => {
      const hide = flags.hideDone && item.checked && !selectionTouches(edState, item.from, item.to);
      if (hide) {
        // Swallow the newline in front of the line so nothing is left
        // where it was; the first line of the document has none, so it
        // takes the one behind it instead.
        const from = item.from > 0 ? item.from - 1 : item.from;
        const to = item.from > 0 ? item.to : Math.min(doc.length, item.to + 1);
        if (to > from) {
          const deco = Decoration.replace({});
          ranges.push(deco.range(from, to));
          atomics.push(deco.range(from, to));
        }
        return;
      }
      let cls = "cm-outline-line";
      if (first) { cls += " cm-outline-top"; first = false; }
      if (item.checked) cls += " cm-outline-done";
      if (i === nextIdx) cls += " cm-outline-next";
      ranges.push(Decoration.line({ class: cls }).range(item.from));
      // Fade the bullet out rather than replacing it: the checkbox is
      // already the marker, but the `-` is real characters the caret
      // still walks through, and collapsing them away would put the
      // cursor somewhere nothing is drawn. Zero opacity leaves the
      // width alone too, so the hang-indent measured from the source
      // prefix still lines the wrap up under the text.
      ranges.push(dashDeco.range(item.markFrom, item.markTo));
    });

    ranges.push(Decoration.widget({
      widget: new OutlineFooterWidget(sig, block.items, flags, bi, first),
      block: true,
      side: 1,
    }).range(block.items[block.items.length - 1].to));
  });

  return {
    deco: RangeSet.of(ranges, true),
    atomic: RangeSet.of(atomics, true),
    hideDone: flags.hideDone,
    pin: flags.pin,
    // Handed to the panel so it doesn't re-scan the document for the one
    // block it draws — the field already walked every line to decide
    // what to collapse.
    pinnedBlock: flags.pin > 0 ? blocks[flags.pin - 1] || null : null,
    // Kept for the Alt-arrow move below, which has to know where an
    // item's children end before it can take them with it.
    blocks,
  };
}

/**
 * One field for every doc surface. Module-level rather than built per
 * editor so the panel below can read it, and so the two extension lists
 * that both include this bundle hand CodeMirror the same extension
 * value — which is what lets it dedupe them instead of running the scan
 * twice on the surface that gets both.
 */
const outlineField = StateField.define({
  create: buildOutlineState,
  update(value, tr) {
    // A cursor move only matters while completed items are hidden: that
    // is the one decoration whose shape depends on where the selection
    // sits. Everywhere else, re-scanning the document on every arrow key
    // would be work for an identical answer.
    if (tr.docChanged || (tr.selection && value.hideDone)) return buildOutlineState(tr.state);
    return value;
  },
  provide: (f) => EditorView.decorations.from(f, (v) => v.deco),
});

/**
 * The docked panel for a pinned outline. Lives on the editor element
 * itself — not in `#editor-container` — so a floating pane, a stack
 * column and the main editor each pin to their own frame rather than
 * one of them pinning to the window on everyone's behalf.
 *
 * Zen Focus is the exception: its overlay paints gradient curtains over
 * its own top and bottom thirds, so a panel docked to the bottom of the
 * editor would be painted out. There the outline shows as one row at the
 * top of the window instead — see `buildOutlineZenStrip`.
 */
const pinnedPanel = ViewPlugin.fromClass(
  class {
    constructor(view) {
      this.view = view;
      this.el = null;
      this.sig = "";
      this.zen = false;
      this.render();
    }

    update(update) {
      if (update.docChanged || update.selectionSet) this.render();
      // The text column is padding on the scroller, and the sidebar,
      // the right-hand bars and a docked pane all move it. Re-read it
      // whenever the geometry moves so the panel stays under the column
      // rather than under the middle of the window.
      if (update.geometryChanged) this.syncColumn();
    }

    destroy() {
      if (this.el) this.el.remove();
      this.el = null;
      this.sig = "";
    }

    /** Align the panel with the editor's text column. Read through
     *  `requestMeasure` — a `getComputedStyle` inside `update` is a
     *  layout read in the middle of CodeMirror's own update cycle. */
    syncColumn() {
      if (!this.el || this.zen) return;
      this.view.requestMeasure({
        read: (v) => {
          const cs = getComputedStyle(v.scrollDOM);
          return { left: cs.paddingLeft, right: cs.paddingRight };
        },
        write: (m) => {
          if (!this.el) return;
          this.el.style.setProperty("--outline-col-left", m.left);
          this.el.style.setProperty("--outline-col-right", m.right);
        },
      });
    }

    render() {
      const value = this.view.state.field(outlineField, false);
      const block = value ? value.pinnedBlock : null;
      if (!block) { this.destroy(); return; }
      const flags = { hideDone: value.hideDone, pin: value.pin };
      const overlay = this.view.dom.closest(".zen-focus-overlay");

      const sig = `${overlay ? "z" : "p"}|` + blockSignature(block, flags, true);
      if (this.el && sig === this.sig) return;
      const wasZen = this.zen;
      this.sig = sig;
      this.zen = !!overlay;

      // A surface can't switch between the two forms in place — they
      // hang off different elements — so a changed form starts over.
      if (this.el && wasZen !== this.zen) { this.el.remove(); this.el = null; }

      if (this.zen) {
        const strip = buildOutlineZenStrip(block.items, (item) => toggleAt(this.view, item.line));
        if (!strip) { this.destroy(); return; }
        if (!this.el) {
          this.el = document.createElement("div");
          overlay.appendChild(this.el);
        }
        this.el.className = "outline-zen-host";
        this.el.replaceChildren(strip);
        return;
      }

      if (!this.el) {
        this.el = document.createElement("div");
        this.el.className = "outline-pinned-panel";
        this.view.dom.appendChild(this.el);
        this.syncColumn();
      }
      this.el.replaceChildren();
      this.el.appendChild(buildOutlineRows(
        block.items, flags.hideDone,
        (item) => toggleAt(this.view, item.line),
      ));
      this.el.appendChild(buildOutlineFooter({
        hideDone: flags.hideDone,
        pinned: true,
        onToggleHideDone: () => patchFlags(this.view, { [HIDE_DONE_KEY]: flags.hideDone ? null : "true" }),
        onTogglePin: () => patchFlags(this.view, { [PIN_KEY]: null }),
      }));
    }
  },
);

/**
 * Outline-aware line moving (Alt-Arrow, CodeMirror's `moveLineUp` /
 * `moveLineDown`).
 *
 * The default commands move one raw line, which on an outline tears a
 * parent away from the items nested under it. Inside an outline an item
 * moves **among its siblings and takes its children with it**, and it
 * never leaves its parent: there is no sibling above the first child or
 * below the last, so the key does nothing there rather than flattening
 * the tree to make room. Outside an outline nothing is claimed and the
 * default runs.
 */

/** Last item index of the unit rooted at `i` — the item plus every
 *  following item indented deeper than it. */
function unitEnd(items, i) {
  let end = i;
  while (end + 1 < items.length && items[end + 1].depth > items[i].depth) end += 1;
  return end;
}

/** The block the whole selection sits in, plus the item indices its
 *  ends land on. Null when the selection isn't inside one outline. */
function selectedItems(edState, blocks) {
  const sel = edState.selection.main;
  const fromLine = edState.doc.lineAt(sel.from).number;
  const toLine = edState.doc.lineAt(sel.to).number;
  for (const block of blocks) {
    if (block.fromLine > fromLine || block.toLine < toLine) continue;
    const a = block.items.findIndex((it) => it.line === fromLine);
    const b = block.items.findIndex((it) => it.line === toLine);
    if (a < 0 || b < 0) return null;
    return { items: block.items, a, b };
  }
  return null;
}

function moveOutlineUnit(view, dir) {
  const value = view.state.field(outlineField, false);
  if (!value || !value.blocks.length) return false;
  const found = selectedItems(view.state, value.blocks);
  if (!found) return false;
  const { items, a, b } = found;

  // Whole units only: a selection that stops halfway through a subtree
  // still moves the subtree.
  const start = a;
  const end = unitEnd(items, Math.max(unitEnd(items, a), b));
  const level = items[start].depth;

  let tStart;
  let tEnd;
  if (dir > 0) {
    const next = end + 1;
    // Past the last sibling, or past the end of the parent's children.
    if (next >= items.length || items[next].depth !== level) return true;
    tStart = next;
    tEnd = unitEnd(items, next);
  } else {
    let p = start - 1;
    while (p >= 0 && items[p].depth > level) p -= 1;
    if (p < 0 || items[p].depth !== level) return true;
    tStart = p;
    tEnd = start - 1;
  }

  const doc = view.state.doc;
  const movedFrom = doc.line(items[start].line).from;
  const movedTo = doc.line(items[end].line).to;
  const targetFrom = doc.line(items[tStart].line).from;
  const targetTo = doc.line(items[tEnd].line).to;
  const moved = doc.sliceString(movedFrom, movedTo);
  const target = doc.sliceString(targetFrom, targetTo);

  const sel = view.state.selection.main;
  const from = dir > 0 ? movedFrom : targetFrom;
  const to = dir > 0 ? targetTo : movedTo;
  const insert = dir > 0 ? `${target}\n${moved}` : `${moved}\n${target}`;
  const delta = dir > 0 ? target.length + 1 : -(target.length + 1);

  view.dispatch({
    changes: { from, to, insert },
    selection: { anchor: sel.anchor + delta, head: sel.head + delta },
    scrollIntoView: true,
    userEvent: "move.outline",
  });
  return true;
}

const outlineKeymap = Prec.high(keymap.of([
  { key: "Alt-ArrowUp", run: (view) => moveOutlineUnit(view, -1) },
  { key: "Alt-ArrowDown", run: (view) => moveOutlineUnit(view, 1) },
]));

/**
 * The outline extension bundle. Carried by BOTH extension lists (the
 * shared one and `editor.js`'s own) — a doc surface that skipped it
 * would render the same file as a plain checklist, which reads as the
 * feature being broken rather than absent.
 */
export function createOutlinePlugin() {
  return outlineExtension;
}

const outlineAtomic = EditorView.atomicRanges.of(
  (view) => view.state.field(outlineField, false)?.atomic || RangeSet.empty,
);

const outlineExtension = [outlineField, outlineAtomic, outlineKeymap, pinnedPanel];
