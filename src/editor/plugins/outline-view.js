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

import { Decoration, EditorView, ViewPlugin, WidgetType } from "@codemirror/view";
import { RangeSet, StateField } from "@codemirror/state";
import { firstOpenIndex, parseOutlineLine, toggleChecklistLine } from "../../outline/outline-model.ts";
import {
  HIDE_DONE_KEY, PIN_KEY, outlineFlagsOf, frontmatterPatchChanges,
} from "../outline-frontmatter.js";
import { propertiesEdit } from "./properties.js";
import { buildOutlineFooter, buildOutlineRows } from "../outline-dom.js";

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
      done: this.items.filter((i) => i.checked).length,
      total: this.items.length,
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
  const empty = { deco: Decoration.none, atomic: RangeSet.empty, hideDone: false, pin: 0, pinnedBlock: null };
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
 */
const pinnedPanel = ViewPlugin.fromClass(
  class {
    constructor(view) {
      this.view = view;
      this.el = null;
      this.sig = "";
      this.render();
    }

    update(update) {
      if (update.docChanged || update.selectionSet) this.render();
    }

    destroy() {
      if (this.el) this.el.remove();
      this.el = null;
      this.sig = "";
    }

    render() {
      const value = this.view.state.field(outlineField, false);
      const block = value ? value.pinnedBlock : null;
      if (!block) { this.destroy(); return; }
      const flags = { hideDone: value.hideDone, pin: value.pin };

      const sig = blockSignature(block, flags, true);
      if (this.el && sig === this.sig) return;
      this.sig = sig;

      if (!this.el) {
        this.el = document.createElement("div");
        this.el.className = "outline-pinned-panel";
        this.view.dom.appendChild(this.el);
      }
      this.el.replaceChildren();
      this.el.appendChild(buildOutlineRows(
        block.items, flags.hideDone,
        (item) => toggleAt(this.view, item.line),
      ));
      this.el.appendChild(buildOutlineFooter({
        done: block.items.filter((i) => i.checked).length,
        total: block.items.length,
        hideDone: flags.hideDone,
        pinned: true,
        onToggleHideDone: () => patchFlags(this.view, { [HIDE_DONE_KEY]: flags.hideDone ? null : "true" }),
        onTogglePin: () => patchFlags(this.view, { [PIN_KEY]: null }),
      }));
    }
  },
);

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

const outlineExtension = [outlineField, outlineAtomic, pinnedPanel];
