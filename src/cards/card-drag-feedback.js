/**
 * What cards being carried show on their way: a ghost of each under the
 * pointer (as they sit relative to the one held), a line over a Doc's
 * text marking the line they will sit beside, and the sidebar row they
 * would go into outlined. Shared by the header drag (card-drag.js) and a
 * canvas's own drag of cards carried off it (card-canvas-drag.js).
 */

import { cardGhost } from "./card-element.js";
import { docPlacement } from "./card-doc-float.js";

/**
 * @param {{ body: string, meta: object, dx?: number, dy?: number }[]} cards
 *   The first is the one held; `dx` / `dy` place the others from it, in
 *   card pixels.
 * @param {{ x: number, y: number }} grab  Where on the held card the
 *   pointer is, in card pixels.
 * @param {Element[]} sources  The cards' own elements, dimmed while a
 *   ghost stands in for them.
 */
export function createDragFeedback(cards, grab, sources) {
  let ghosts = null;
  let dropLine = null;
  let hoverRow = null;

  function setGhosts(on, x, y) {
    if (on && !ghosts) {
      ghosts = cards.map((c) => {
        const g = cardGhost(c.body, c.meta);
        document.documentElement.appendChild(g);
        return g;
      });
    }
    ghosts?.forEach((g, i) => {
      g.style.display = on ? "" : "none";
      if (on) g.style.transform = `translate(${x - grab.x + (cards[i].dx || 0)}px, ${y - grab.y + (cards[i].dy || 0)}px)`;
    });
    for (const el of sources) el.classList.toggle("dragging-source", on);
  }

  function setDropLine(view, place) {
    if (!view) { dropLine?.remove(); dropLine = null; return; }
    if (!dropLine) {
      dropLine = document.createElement("div");
      dropLine.className = "hush-card-drop-line";
      document.body.appendChild(dropLine);
    }
    const r = view.contentDOM.getBoundingClientRect();
    Object.assign(dropLine.style, { left: `${r.left}px`, width: `${r.width}px`, top: `${place.lineY - 1}px` });
  }

  function setHoverRow(row) {
    if (row === hoverRow) return;
    hoverRow?.classList.remove("sl-drop-target-item");
    hoverRow = row;
    hoverRow?.classList.add("sl-drop-target-item");
  }

  return {
    /** Show what letting go at (x, y) over `target` would do; `ghost`
     *  is whether the ghost stands in for the cards there. */
    show(target, x, y, ghost) {
      setGhosts(ghost, x, y);
      // Over a Doc's text the line marks the line the cards will sit
      // beside; over its margin the ghost already shows where.
      const place = target?.kind === "cm" ? docPlacement(target.view, x, y, grab, cards[0].meta) : null;
      setDropLine(place?.overText ? target.view : null, place);
      setHoverRow(target?.kind === "row" || target?.kind === "home" ? target.el : null);
    },
    clear() {
      ghosts?.forEach((g) => g.remove());
      ghosts = null;
      setDropLine(null);
      setHoverRow(null);
      for (const el of sources) el.classList.remove("dragging-source");
    },
  };
}
