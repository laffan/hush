/**
 * Cards beside a Doc's text. A card never moves the text: its markdown
 * stays in the document at its *anchor* — the line it belongs beside —
 * but in the text it is only a zero-height block widget over its lines
 * (so the caret steps over it and nothing can type into it), and the
 * card itself is drawn by `cardFloatLayer`, a layer inside the editor's
 * scroller positioned from the anchor line's height-map entry, so it
 * scrolls with the words it belongs to.
 *
 * **Where it sits.** By default in the right margin, level with its
 * anchor line. Dragged somewhere in a margin it stays where it was put:
 * `xPos` (from the text column's left edge; negative is the left margin)
 * and `yPos` (from the anchor line's top) in its metadata. Cards that
 * would overlap stack downward instead.
 *
 * **Making room.** Where the right margin is narrower than
 * `MIN_MARGIN` — a narrow window, a pane — the text gives up a gutter of
 * that width on its right for the cards (`cm-card-gutter` on the editor,
 * padding on `.cm-content`), and cards fit into it, narrowed as far as
 * they must be. A card is narrowed to fit its margin rather than let it
 * cover the words. A margin is only what can be seen of it: the main
 * editor's column layout says how much of each edge its chrome covers —
 * an inset sidebar, the right-hand bars, docked panes (`--edge-cover-*`,
 * editor/modes.js), and the right sidebar's toggle where it floats over
 * the editor — and cards stay out of that.
 *
 * **Pinned.** A pinned card (`pinned`, `pinY`) is held in view: it sits
 * `pinY` below the top of the editor's visible area in a second layer,
 * outside the scroller, so the text scrolls under it. Its markdown stays
 * at its anchor, and unpinning re-anchors it beside the line it is level
 * with by then (card-doc-plugin.js).
 */

import { ViewPlugin, WidgetType } from "@codemirror/view";
import { cardSize, withoutPosition, CARD_MIN_WIDTH } from "./card-model.ts";
import { cardsHidden } from "./card-facet.js";

/** What a card leaves in the text: nothing you can see. */
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

/** A margin narrower than this gets a gutter carved out of the text. */
export const MIN_MARGIN = 100;
const GAP = 10;        // between a card and the text
const EDGE = 6;        // between a card and the surface's edge
const STACK_GAP = 8;   // between two cards stacked in one margin
const NARROWEST = 60;  // a card in a gutter, at its narrowest

function textEdges(view) {
  const content = view.contentDOM.getBoundingClientRect();
  const pad = parseFloat(getComputedStyle(view.contentDOM).paddingRight) || 0;
  const scroller = view.scrollDOM.getBoundingClientRect();
  const sc = getComputedStyle(view.scrollDOM);
  let visRight = scroller.left + view.scrollDOM.clientWidth - (parseFloat(sc.getPropertyValue("--edge-cover-right")) || 0);
  // The right sidebar's toggle floats over the window's right edge
  // (ui/right-panel-setup.js), and a card in the margin ran under it.
  // Where it lies over this editor it covers that edge like any other
  // chrome: the margin ends at its left. (A zero rect is a hidden toggle.)
  const toggle = document.querySelector(".right-panel-trigger")?.getBoundingClientRect();
  if (toggle && toggle.width && toggle.left < visRight && toggle.right > scroller.left
      && toggle.bottom > scroller.top && toggle.top < scroller.bottom) {
    visRight = Math.min(visRight, toggle.left);
  }
  return {
    content,
    scroller,
    textLeft: content.left,
    textRight: content.right - pad,
    visLeft: scroller.left + (parseFloat(sc.getPropertyValue("--edge-cover-left")) || 0),
    visRight,
    gutter: view.dom.classList.contains("cm-card-gutter"),
  };
}

/**
 * Where a card let go at (x, y) over `view` goes. `grab` is where on the
 * card it is held, in the card's own pixels. Over the text: beside the
 * line under the pointer, in the default place. Over a margin with room
 * for it: where it was let go, beside the line at its top edge. (In a
 * gutter there is one place — the gutter — so only the height is kept.)
 *
 * A pinned card stays pinned, held in view where it was let go.
 *
 * Returns `{ pos, lineY, overText, meta }`: the card's markdown goes in
 * on a line of its own before `pos`, carrying `meta`.
 */
export function docPlacement(view, x, y, grab, meta) {
  const { textLeft, textRight, visLeft, visRight, gutter, scroller } = textEdges(view);
  const docTop = view.documentTop;
  const plain = withoutPosition(meta);
  if (meta?.pinned) Object.assign(plain, { pinned: true, pinY: Math.max(0, Math.round(y - grab.y - scroller.top)) });
  if (x >= textLeft && x <= textRight) {
    const block = view.lineBlockAtHeight(y - docTop);
    return { pos: block.from, lineY: docTop + block.top, overText: true, meta: plain };
  }
  const top = y - grab.y;
  const block = view.lineBlockAtHeight(Math.max(0, top - docTop));
  const yPos = Math.max(0, Math.round(top - (docTop + block.top)));
  const right = x > textRight;
  const room = right ? visRight - textRight : textLeft - visLeft;
  const next = gutter || room < MIN_MARGIN
    ? { ...plain, yPos }
    : { ...plain, xPos: Math.round(x - grab.x - textLeft), yPos };
  return { pos: block.from, lineY: docTop + block.top, overText: false, meta: next };
}

/**
 * The layer that draws a Doc's cards. Each card keeps its element across
 * edits: entries follow their card's first offset through every change,
 * so typing above a card, or in it, never rebuilds it.
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
      // Pinned cards: outside the scroller, so the text scrolls under them.
      this.pinLayer = document.createElement("div");
      this.pinLayer.className = "cm-card-float-layer cm-card-pin-layer";
      view.dom.appendChild(this.pinLayer);
      // Out of the scroller, a pinned card would stop the wheel: pass it on.
      this.pinLayer.addEventListener("wheel", (e) => {
        if (e.ctrlKey) return;
        const unit = e.deltaMode === 1 ? 16 : 1;
        view.scrollDOM.scrollBy(e.deltaX * unit, e.deltaY * unit);
        e.preventDefault();
      }, { passive: false });
      // A card that changes height (typed into, narrowed) restacks the
      // cards below it without any change to the document.
      this.resize = typeof ResizeObserver === "function" ? new ResizeObserver(() => this.measure()) : null;
      this.sync(view.state);
      this.measure();
    }

    update(u) {
      if (u.docChanged) for (const e of this.entries) e.from = u.changes.mapPos(e.from, -1);
      if (u.startState.field(field, false) !== u.state.field(field, false)) this.sync(u.state);
      // The column can move with nothing CodeMirror calls a change: the
      // sidebar opening or closing re-pads the scroller (editor/modes.js
      // writes its padding and edge cover, then dispatches an empty
      // transaction), and the text slid under a left-margin card.
      const frame = this.frame();
      if (frame !== this.lastFrame) { this.lastFrame = frame; this.measure(); }
      else if (u.docChanged || u.geometryChanged || u.heightChanged || u.viewportChanged) this.measure();
    }

    /** The scroller's inline padding and edge cover — reads no layout. */
    frame() {
      const s = this.view.scrollDOM.style;
      return `${s.paddingLeft}|${s.paddingRight}|${s.getPropertyValue("--edge-cover-left")}|${s.getPropertyValue("--edge-cover-right")}`;
    }

    spans(state) {
      if (state.facet(cardsHidden)) return [];
      return state.field(field, false)?.cards || [];
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
          e = { from: span.from, host };
          const entry = e;
          e.binding = bind(this.view, host, span, () => this.spans(this.view.state).find((s) => s.from === entry.from) || null);
          this.resize?.observe(host);
        }
        e.meta = span.meta;
        const parent = span.meta.pinned ? this.pinLayer : this.layer;
        if (e.host.parentNode !== parent) parent.appendChild(e.host);
        next.push(e);
      }
      for (const e of left) { this.resize?.unobserve(e.host); e.binding.destroy(); e.host.remove(); }
      this.entries = next;
      if (!next.length) this.setGutter(false);
    }

    setGutter(on) {
      const dom = this.view.dom;
      if (dom.classList.contains("cm-card-gutter") === on) return;
      dom.classList.toggle("cm-card-gutter", on);
      dom.style.setProperty("--card-gutter", `${MIN_MARGIN}px`);
      // The text rewraps in the new width: have CodeMirror re-measure it.
      requestAnimationFrame(() => this.view.requestMeasure());
    }

    measure() {
      if (!this.entries.length) return;
      this.view.requestMeasure({
        key: this,
        read: (view) => {
          const edges = textEdges(view);
          const scroller = edges.scroller;
          const originX = scroller.left - view.scrollDOM.scrollLeft;
          const originY = scroller.top - view.scrollDOM.scrollTop;
          // The pin layer's origin, and the height it holds pinned cards in.
          const editor = view.dom.getBoundingClientRect();
          const visH = view.scrollDOM.clientHeight;
          // Whether the text needs to make room is judged on the margin
          // it would have *without* the gutter, or the gutter would take
          // itself away again.
          const ownPad = edges.gutter ? MIN_MARGIN : 0;
          const naturalRight = edges.visRight - edges.textRight - ownPad;
          const gutter = naturalRight < MIN_MARGIN;
          const textRight = edges.textRight + ownPad - (gutter ? MIN_MARGIN : 0);
          const colLeft = edges.textLeft - originX;
          const colRight = textRight - originX;
          const visLeft = edges.visLeft - originX + EDGE;
          const visRight = edges.visRight - originX - EDGE;
          const leftRoom = colLeft - GAP - visLeft;
          const rightRoom = visRight - colRight - GAP;
          const placed = this.entries.map((e) => {
            const block = view.lineBlockAt(Math.min(e.from, view.state.doc.length));
            const want = cardSize(e.meta).width;
            const hasX = typeof e.meta.xPos === "number";
            // Left only where the card was put there and the left margin
            // can hold one; everything else is the right margin's.
            const leftSide = !gutter && hasX && e.meta.xPos + want / 2 < colRight - colLeft - want / 2
              && e.meta.xPos < 0 && leftRoom >= MIN_MARGIN - GAP;
            const room = leftSide ? leftRoom : rightRoom;
            const width = Math.max(NARROWEST, Math.min(want, room));
            let left;
            if (leftSide) left = Math.max(visLeft, Math.min(colLeft + e.meta.xPos, colLeft - GAP - width));
            else if (hasX && !gutter) left = Math.min(Math.max(colLeft + e.meta.xPos, colRight + GAP), visRight - width);
            else left = colRight + GAP;
            const height = e.host.firstElementChild?.offsetHeight || 0;
            if (e.meta.pinned) {
              // Held in view, in the pin layer's coordinates; kept on screen
              // when the editor is shorter than where it was pinned.
              const y = Math.max(0, Math.min(Number(e.meta.pinY) || 0, visH - height));
              return { e, left: left + originX - editor.left, top: scroller.top - editor.top + y, width, height, side: "pin" };
            }
            const top = view.documentTop - originY + block.top + (typeof e.meta.yPos === "number" ? e.meta.yPos : 0);
            return { e, left, top, width, height, side: leftSide ? "l" : "r" };
          });
          // Cards that would overlap in one margin stack downward (pinned
          // ones sit where they were put).
          for (const side of ["l", "r"]) {
            let bottom = -Infinity;
            for (const p of placed.filter((q) => q.side === side).sort((a, b) => a.top - b.top)) {
              if (p.top < bottom + STACK_GAP) p.top = bottom + STACK_GAP;
              bottom = p.top + p.height;
            }
          }
          return { gutter, placed };
        },
        write: ({ gutter, placed }) => {
          this.setGutter(gutter);
          for (const { e, left, top, width } of placed) {
            if (!e.host.isConnected) continue;
            e.host.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
            e.host.style.setProperty("--float-w", `${Math.round(width)}px`);
            e.host.firstElementChild?.classList.toggle("narrow", width < CARD_MIN_WIDTH);
          }
        },
      });
    }

    destroy() {
      this.resize?.disconnect();
      for (const e of this.entries) e.binding.destroy();
      this.entries = [];
      this.layer.remove();
      this.pinLayer.remove();
      this.view.dom.classList.remove("cm-card-gutter");
    }
  });
}
