/**
 * Cards pulled out of a Doc's text into its margin.
 *
 * A card in a Doc sits in the text by default (a block between two
 * lines). Dragged into the margin, it floats there instead: its markdown
 * stays in the document — moved to the line it now sits beside, its
 * *anchor* — but it takes no room in the text, which closes up behind
 * it. Where it floats is kept in its metadata as `xPos` (from the left
 * edge of the text column; negative is the left margin) and `yPos` (from
 * the top of the anchor line), so it scrolls with the words it belongs
 * to and comes back in the same place next time. Dropped back over the
 * text column, it goes back into the flow and loses both keys.
 *
 * In the text a floating card is a zero-height block widget over its
 * lines (so the caret still steps over it and nothing can type into it);
 * the card itself is drawn by `cardFloatLayer`, a layer inside the
 * editor's scroller positioned from the anchor line's height-map entry.
 */

import { ViewPlugin, WidgetType } from "@codemirror/view";
import { cardSize, isFloating, withoutPosition, CARD_MIN_WIDTH } from "./card-model.ts";

/** What a floating card leaves in the text: nothing you can see. */
export class CardAnchorWidget extends WidgetType {
  eq() { return true; }
  toDOM() {
    const el = document.createElement("div");
    el.className = "cm-card-anchor";
    return el;
  }
  get estimatedHeight() { return 0; }
  ignoreEvent() { return true; }
}

const GAP = 12;   // between a floating card and the text column
const EDGE = 8;   // between a floating card and the surface's edge

/**
 * Where a card let go at (x, y) over `view` goes. Over the text column:
 * into the flow at the nearest line boundary. Over a margin: floating in
 * that margin, beside the line at its top edge — fitted into the margin
 * (narrowed, down to the minimum width, if the margin is narrow), since
 * pulling a card into the margin is the point.
 *
 * `grab` is where on the card it is held, in the card's own pixels.
 * Returns `{ pos, before, lineY, float, meta }`: insert the card at `pos`
 * (on a line of its own before / after), carrying `meta`.
 */
export function docPlacement(view, x, y, grab, meta) {
  const content = view.contentDOM.getBoundingClientRect();
  const docTop = view.documentTop;
  if (x >= content.left && x <= content.right) {
    const block = view.lineBlockAtHeight(y - docTop);
    const before = y < docTop + (block.top + block.bottom) / 2;
    return {
      pos: before ? block.from : block.to,
      before,
      lineY: docTop + (before ? block.top : block.bottom),
      float: false,
      meta: withoutPosition(meta),
    };
  }
  const scroller = view.scrollDOM.getBoundingClientRect();
  const visibleRight = scroller.left + view.scrollDOM.clientWidth;
  const right = x > content.right;
  const lo = right ? content.right + GAP : scroller.left + EDGE;
  const hi = right ? visibleRight - EDGE : content.left - GAP;
  const size = cardSize(meta);
  const width = Math.min(size.width, Math.max(CARD_MIN_WIDTH, hi - lo));
  const left = Math.max(lo, Math.min(hi - width, x - Math.min(grab.x, width - 12)));
  const top = y - grab.y;
  const block = view.lineBlockAtHeight(Math.max(0, top - docTop));
  const next = { ...meta, xPos: left - content.left, yPos: top - (docTop + block.top) };
  if (width !== size.width) next.width = width;
  return { pos: block.from, before: true, lineY: docTop + block.top, float: true, meta: next };
}

/**
 * The layer that draws a Doc's floating cards. Each card keeps its
 * element across edits: entries follow their card's first offset through
 * every change, so typing above a card, or in it, never rebuilds it.
 *
 * @param {object} o
 * @param {import("@codemirror/state").StateField} o.field  The card field.
 * @param {(view, host, span, locate) => { take(span): void, destroy(): void }} o.bind
 */
export function createCardFloatLayer({ field, bind }) {
  return ViewPlugin.fromClass(class {
    constructor(view) {
      this.view = view;
      this.entries = [];
      this.layer = document.createElement("div");
      this.layer.className = "cm-card-float-layer";
      view.scrollDOM.appendChild(this.layer);
      this.sync(view.state);
      this.measure();
    }

    update(u) {
      if (u.docChanged) for (const e of this.entries) e.from = u.changes.mapPos(e.from, -1);
      if (u.startState.field(field, false) !== u.state.field(field, false)) this.sync(u.state);
      if (u.docChanged || u.geometryChanged || u.heightChanged || u.viewportChanged) this.measure();
    }

    spans(state) {
      return (state.field(field, false)?.cards || []).filter((c) => isFloating(c.meta));
    }

    sync(state) {
      const next = [];
      const left = new Set(this.entries);
      for (const span of this.spans(state)) {
        let e = [...left].find((x) => x.from === span.from);
        if (e) {
          left.delete(e);
          e.binding.take(span);
        } else {
          const host = document.createElement("div");
          host.className = "cm-card-float";
          host.style.setProperty("--float-w", `${cardSize(span.meta).width}px`);
          this.layer.appendChild(host);
          e = { from: span.from, host, width: 0 };
          const entry = e;
          e.binding = bind(this.view, host, span, () => this.spans(this.view.state).find((s) => s.from === entry.from) || null);
        }
        e.meta = span.meta;
        next.push(e);
      }
      for (const e of left) { e.binding.destroy(); e.host.remove(); }
      this.entries = next;
    }

    measure() {
      if (!this.entries.length) return;
      this.view.requestMeasure({
        key: this,
        read: (view) => {
          const scroller = view.scrollDOM.getBoundingClientRect();
          const content = view.contentDOM.getBoundingClientRect();
          const originX = scroller.left - view.scrollDOM.scrollLeft;
          const originY = scroller.top - view.scrollDOM.scrollTop;
          const colLeft = content.left - originX;
          const colRight = colLeft + content.width;
          const visLeft = view.scrollDOM.scrollLeft + EDGE;
          const visRight = view.scrollDOM.scrollLeft + view.scrollDOM.clientWidth - EDGE;
          return this.entries.map((e) => {
            const block = view.lineBlockAt(Math.min(e.from, view.state.doc.length));
            // Fitted into its margin as the surface is now — a window
            // narrowed since the card was placed (or a pane, with less
            // margin to give) narrows the card before it lets it cover
            // the text.
            let width = cardSize(e.meta).width;
            let left = colLeft + e.meta.xPos;
            if (e.meta.xPos + width / 2 >= content.width / 2) {
              width = Math.min(width, Math.max(CARD_MIN_WIDTH, visRight - colRight - GAP));
              left = Math.min(Math.max(left, colRight + GAP), visRight - width);
            } else {
              width = Math.min(width, Math.max(CARD_MIN_WIDTH, colLeft - GAP - visLeft));
              left = Math.max(Math.min(left, colLeft - GAP - width), visLeft);
            }
            const top = view.documentTop - originY + block.top + e.meta.yPos;
            return { e, left, top, width };
          });
        },
        write: (pos) => {
          for (const { e, left, top, width } of pos) {
            if (!e.host.isConnected) continue;
            e.host.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
            e.host.style.setProperty("--float-w", `${Math.round(width)}px`);
          }
        },
      });
    }

    destroy() {
      for (const e of this.entries) e.binding.destroy();
      this.entries = [];
      this.layer.remove();
    }
  });
}
