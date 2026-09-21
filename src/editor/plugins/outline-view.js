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
import { Facet, Prec, RangeSet, StateField } from "@codemirror/state";
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

/** The bullet before a checkbox, painted at zero opacity. */
const dashDeco = Decoration.mark({ class: "cm-outline-dash" });

/** The strike over a completed item. A mark over the item's words only,
 *  never the line: a `text-decoration` on the line is drawn across every
 *  atomic inline in it (the spec says so, and every engine obliges), so
 *  the rule ran through the checkbox and back over the hidden bullet
 *  before it ever reached a word. */
const doneTextDeco = Decoration.mark({ class: "cm-outline-done-text" });

/**
 * The span of an item's own words — its line, less the `- [x] ` prefix
 * and any whitespace at either end.
 *
 * `item.text` is the tail the checklist pattern captured, so its length
 * measures back from the end of the line; trimming both ends keeps the
 * strike off a trailing space, which is exactly the overhang past the
 * last word that reads as "the line is struck through" rather than "the
 * words are". Returns null for an item with nothing in it.
 */
function itemTextSpan(item) {
  const lead = item.text.length - item.text.trimStart().length;
  const trail = item.text.length - item.text.trimEnd().length;
  const from = item.to - item.text.length + lead;
  const to = item.to - trail;
  return to > from ? { from, to } : null;
}

/** Collapse `[from, to]` and the line break that would otherwise be left
 *  where it was — the newline in front of it, or the one behind it when
 *  the span starts the document. Returns null when there is nothing to
 *  take (a one-line document). */
function collapseSpan(doc, from, to) {
  if (from > 0) return { from: from - 1, to };
  if (doc.lines > 1) return { from, to: Math.min(doc.length, to + 1) };
  return null;
}

/**
 * Set on the Zen Focus overlay's editor (zen-focus.js adds it to that
 * one surface's extension list). Zen is one line at a time: a checklist
 * is not prose, so its outlines fold away entirely for the duration —
 * a pinned one reappears as the single row the panel plugin docks to
 * the top of the window, and an unpinned one simply isn't there.
 */
export const outlineZenSurface = Facet.define({
  combine: (values) => values.some(Boolean),
});

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

  const zen = edState.facet(outlineZenSurface);
  const ranges = [];
  const atomics = [];
  blocks.forEach((block, bi) => {
    const pinned = flags.pin === bi + 1;
    const sig = blockSignature(block, flags, pinned);

    // A pinned outline is drawn by the panel, and in Zen every outline
    // stands down. Either way the block leaves the text entirely: there
    // is nothing useful to leave in its place, and the way back is the
    // panel's own unpin.
    if (pinned || zen) {
      const span = collapseSpan(doc, block.items[0].from, block.items[block.items.length - 1].to);
      if (span) {
        const deco = Decoration.replace({});
        ranges.push(deco.range(span.from, span.to));
        atomics.push(deco.range(span.from, span.to));
      }
      return;
    }

    const nextIdx = firstOpenIndex(block.items);
    let first = true;
    block.items.forEach((item, i) => {
      const hide = flags.hideDone && item.checked && !selectionTouches(edState, item.from, item.to);
      if (hide) {
        const span = collapseSpan(doc, item.from, item.to);
        if (span) {
          const deco = Decoration.replace({});
          ranges.push(deco.range(span.from, span.to));
          atomics.push(deco.range(span.from, span.to));
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
      if (item.checked) {
        const span = itemTextSpan(item);
        if (span) ranges.push(doneTextDeco.range(span.from, span.to));
      }
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

/** Shortest a dragged panel may be: its grip, one row, and its footer. */
const MIN_PIN_HEIGHT = 84;

/** Built per editor, so the panel and the keymap beside it can close
 *  over this surface's own field. No surface gets both extension lists
 *  (`editor.js` assembles its own; everything else comes from
 *  `createBaseExtensions`), so there is nothing to share. */
function makeOutlineField() {
  return StateField.define({
    create: buildOutlineState,
    update(value, tr) {
      // A cursor move only matters while completed items are hidden:
      // that is the one decoration whose shape depends on where the
      // selection sits. Everywhere else, re-scanning the document on
      // every arrow key would be work for an identical answer.
      if (tr.docChanged || (tr.selection && value.hideDone)) return buildOutlineState(tr.state);
      return value;
    },
    provide: (f) => EditorView.decorations.from(f, (v) => v.deco),
  });
}

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
function makePinnedPanel(field, appState) {
  return ViewPlugin.fromClass(
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

    /** The height the user dragged the panel to, or null for "as tall
     *  as its contents". Per device, like every other panel size in the
     *  app — it describes this screen, not the document. */
    storedHeight() {
      const n = Number(appState?.settings?.outlinePinnedHeight);
      return Number.isFinite(n) && n > 0 ? n : null;
    }

    applyStoredHeight() {
      if (!this.el || this.zen) return;
      const h = this.storedHeight();
      this.el.style.height = h ? `${h}px` : "";
      // The CSS cap is what keeps an *unsized* panel from swallowing the
      // frame. Once the user has said how tall they want it, that answer
      // wins — the drag clamps against the frame itself, which is the
      // bound that actually matters.
      this.el.style.maxHeight = h ? "none" : "";
    }

    /** Drag the panel's top edge to set how much of the frame it takes.
     *  The grip is a child of the panel rather than a free-floating
     *  strip: the panel tracks the text column, and a strip positioned
     *  independently would have to be kept in step with it on every
     *  sidebar toggle. */
    buildGrip() {
      const grip = document.createElement("div");
      grip.className = "outline-pin-grip";
      grip.setAttribute("role", "separator");
      grip.setAttribute("aria-orientation", "horizontal");
      grip.addEventListener("mousedown", (e) => e.stopPropagation());
      grip.addEventListener("pointerdown", (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        const startY = e.clientY;
        const startH = this.el.getBoundingClientRect().height;
        const hostH = this.view.dom.getBoundingClientRect().height;
        grip.classList.add("dragging");
        // Same reason as above: while the user is sizing it by hand the
        // proportional cap has nothing to say.
        this.el.style.maxHeight = "none";
        try { grip.setPointerCapture(e.pointerId); } catch (_) { /* no capture */ }

        let pending = false;
        let latestY = startY;
        let applied = startH;
        const flush = () => {
          pending = false;
          // Dragging up (a negative delta) makes it taller. Never past
          // the frame that holds it, and never so short that the footer
          // is all that survives.
          const max = Math.max(MIN_PIN_HEIGHT, hostH - 48);
          applied = Math.max(MIN_PIN_HEIGHT, Math.min(max, startH - (latestY - startY)));
          this.el.style.height = `${Math.round(applied)}px`;
        };
        const onMove = (me) => {
          latestY = me.clientY;
          if (pending) return;
          pending = true;
          requestAnimationFrame(flush);
        };
        const onUp = () => {
          grip.classList.remove("dragging");
          grip.removeEventListener("pointermove", onMove);
          grip.removeEventListener("pointerup", onUp);
          grip.removeEventListener("pointercancel", onUp);
          appState?.updateSettings?.({ outlinePinnedHeight: Math.round(applied) });
        };
        grip.addEventListener("pointermove", onMove);
        grip.addEventListener("pointerup", onUp);
        grip.addEventListener("pointercancel", onUp);
      });
      return grip;
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
      const value = this.view.state.field(field, false);
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
      this.applyStoredHeight();
      this.el.replaceChildren(this.buildGrip());
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
}

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

function moveOutlineUnit(view, field, dir) {
  const value = view.state.field(field, false);
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

function makeOutlineKeymap(field) {
  return Prec.high(keymap.of([
    { key: "Alt-ArrowUp", run: (view) => moveOutlineUnit(view, field, -1) },
    { key: "Alt-ArrowDown", run: (view) => moveOutlineUnit(view, field, 1) },
  ]));
}

/**
 * The outline extension bundle. Carried by BOTH extension lists (the
 * shared one and `editor.js`'s own) — a doc surface that skipped it
 * would render the same file as a plain checklist, which reads as the
 * feature being broken rather than absent.
 */
export function createOutlinePlugin(appState) {
  const field = makeOutlineField();
  const atomic = EditorView.atomicRanges.of(
    (view) => view.state.field(field, false)?.atomic || RangeSet.empty,
  );
  return [field, atomic, makeOutlineKeymap(field), makePinnedPanel(field, appState)];
}
