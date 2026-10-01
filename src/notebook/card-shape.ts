/**
 * Cards on a canvas — the model half. A card is a `TextShape` with
 * `card: true` (see types.ts): `text` is its markdown body, `position`
 * its top-left corner, and `cardMeta` everything else a card carries, in
 * the same keys a Doc's `{{…}}` line uses. The DOM layer that shows and
 * edits them is `ui/card-layer.ts`; this file only changes the model, the
 * same way `bookmarks.ts` does for bookmarks, so the layer, the drag, the
 * sidebar and Courier all go through one set of mutations.
 */

import type { DrawingState } from "./state";
import type { Point, Shape, TextShape } from "./types";
import { generateId } from "./utils";
import { cardBounds } from "./card-geometry";
import {
  cardSize, cardTitle, withoutPosition, CARD_DEFAULT_HEIGHT, CARD_DEFAULT_WIDTH, CARD_HEADER_HEIGHT, type CardMeta,
} from "../cards/card-model";

export function isCardShape(s: Shape | null | undefined): s is TextShape {
  return !!s && s.type === "text" && !!s.card;
}

/** The metadata a card keeps on a canvas: everything but its place in a
 *  Doc — its position here is the shape's own. */
function storedMeta(meta: CardMeta | null | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(withoutPosition(meta))) {
    if (v === undefined || v === null) continue;
    out[k] = v;
  }
  return out;
}

/** A card's metadata as it travels to another surface. Its position
 *  here stays behind: a canvas card dropped into a Doc takes the place
 *  it is dropped on. */
export function cardMetaOf(shape: TextShape): CardMeta {
  return { ...(shape.cardMeta || {}) };
}

export function makeCardShape(body: string, meta: CardMeta | null | undefined, at: Point, layerId?: string): TextShape {
  return {
    id: generateId(),
    type: "text",
    card: true,
    position: { x: at.x, y: at.y },
    text: body,
    fontSize: 14,
    color: "#000000",
    width: cardSize(meta).width,
    cardMeta: storedMeta(meta),
    layerId,
    createdAt: Date.now(),
  };
}

/** Add a card at `at` (its top-left corner). Returns the new shape. */
export function addCardShape(
  state: DrawingState, body: string, meta: CardMeta | null | undefined, at: Point,
  opts: { select?: boolean; focus?: boolean } = {},
): TextShape {
  const shape = makeCardShape(body, meta, at, state.activeLayerId);
  state.shapes = [...state.shapes, shape];
  if (opts.select !== false) {
    state.selectedIds = new Set([shape.id]);
    state.notify("selectedIds");
  }
  if (opts.focus) state.focusCardId = shape.id;
  state.recordHistory();
  state.notify("shapes");
  return shape;
}

/** Add a card centred on a world point. */
export function addCardShapeCentred(state: DrawingState, body: string, meta: CardMeta | null | undefined, center: Point): TextShape {
  const { width } = cardSize(meta);
  const h = meta?.collapsed ? CARD_HEADER_HEIGHT : CARD_DEFAULT_HEIGHT;
  return addCardShape(state, body, meta, { x: center.x - width / 2, y: center.y - h / 2 });
}

/** Change a card's body and / or metadata. `record` is false while the
 *  user is typing — the layer records one step when they pause. */
export function patchCardShape(
  state: DrawingState, id: string, patch: { text?: string; cardMeta?: CardMeta }, record = true,
): void {
  let found = false;
  state.shapes = state.shapes.map((s) => {
    if (s.id !== id || s.type !== "text" || !s.card) return s;
    found = true;
    const next: TextShape = { ...s };
    if (patch.text !== undefined) next.text = patch.text;
    if (patch.cardMeta !== undefined) {
      next.cardMeta = storedMeta(patch.cardMeta);
      next.width = cardSize(patch.cardMeta).width;
    }
    return next;
  });
  if (!found) return;
  if (record) state.recordHistory();
  state.notify("shapes");
}

export function removeCardShape(state: DrawingState, id: string): boolean {
  if (!state.shapes.some((s) => s.id === id)) return false;
  state.shapes = state.shapes.filter((s) => s.id !== id);
  if (state.selectedIds.has(id)) {
    const next = new Set(state.selectedIds);
    next.delete(id);
    state.selectedIds = next;
    state.notify("selectedIds");
  }
  state.recordHistory();
  state.notify("shapes");
  return true;
}

/** Take several cards off the canvas as one undo step (a selection of
 *  cards carried off to another surface). */
export function removeCardShapes(state: DrawingState, ids: string[]): void {
  const gone = new Set(ids);
  if (!state.shapes.some((s) => gone.has(s.id))) return;
  state.shapes = state.shapes.filter((s) => !gone.has(s.id));
  const next = new Set([...state.selectedIds].filter((id) => !gone.has(id)));
  if (next.size !== state.selectedIds.size) { state.selectedIds = next; state.notify("selectedIds"); }
  state.recordHistory();
  state.notify("shapes");
}

/** Fold a card to its header, or unfold it (a double-click on its
 *  header strip). */
export function toggleCardCollapsed(state: DrawingState, id: string): void {
  const s = state.shapes.find((x) => x.id === id);
  if (!isCardShape(s)) return;
  const meta = { ...(s.cardMeta || {}) } as CardMeta;
  patchCardShape(state, id, { cardMeta: { ...meta, collapsed: !meta.collapsed } });
}

/** Record the heights the card layer measured its cards' words at, so
 *  the canvas selects, frames and groups each card by the box it shows.
 *  Not an undo step: nothing the user did changed. */
export function setCardHeights(state: DrawingState, heights: Map<string, number>): void {
  let changed = false;
  const next = state.shapes.map((s) => {
    const h = heights.get(s.id);
    if (h === undefined || !isCardShape(s) || s.cardHeight === h) return s;
    changed = true;
    return { ...s, cardHeight: h };
  });
  if (!changed) return;
  state.shapes = next;
  state.notify("shapes");
}

/** The selected text shapes that can become cards (not already cards,
 *  not outlines, on a layer the pointer can reach). */
export function convertibleToCards(state: DrawingState): TextShape[] {
  const inert = state._inertLayerIds();
  return state.shapes.filter((s): s is TextShape => s.type === "text" && state.selectedIds.has(s.id)
    && !s.card && !s.outline && !s.headerLabel && !(s.layerId && inert.has(s.layerId)));
}

/** Make cards of text shapes where they stand (⌘⇧, on a canvas) — one
 *  undo step. The words are kept; the shape's own styling is not, since a
 *  card has its own. */
export function convertShapesToCards(state: DrawingState, ids: string[]): void {
  const pick = new Set(ids);
  state.shapes = state.shapes.map((s) => {
    if (!pick.has(s.id) || s.type !== "text" || s.card) return s;
    const { backgroundColor: _b, borderColor: _c, borderWidth: _w, fontFamily: _f, bold: _k, manualWidth: _m, ...rest } = s;
    return { ...rest, card: true, cardMeta: {}, fontSize: 14, color: "#000000", width: CARD_DEFAULT_WIDTH };
  });
  state.recordHistory();
  state.notify("shapes");
}

/** Turn a card back into ordinary text where it stands — insert-at-
 *  cursor on a canvas with no document to insert into. */
export function uncardShape(state: DrawingState, id: string): void {
  state.shapes = state.shapes.map((s) => {
    if (s.id !== id || s.type !== "text" || !s.card) return s;
    const { card: _c, cardMeta: _m, ...rest } = s;
    return { ...rest, fontSize: state.fontSize, width: state.maxTextWidth };
  });
  state.recordHistory();
  state.notify("shapes");
}

/** Centre a card in the view and select it (a sidebar card row). */
export function focusCardShape(state: DrawingState, id: string): boolean {
  if (!state.shapes.some((s) => s.id === id && isCardShape(s))) return false;
  state.focusShape(id);
  return true;
}

/** `{ id, title, bgColor }` for every card, in reading order — what the
 *  sidebar lists under a notebook. */
export function cardIndexOf(shapes: Shape[]): { id: string; title: string; bgColor?: string }[] {
  return shapes
    .filter(isCardShape)
    .sort((a, b) => (a.position.y - b.position.y) || (a.position.x - b.position.x))
    .map((s) => ({ id: s.id, title: cardTitle(s.text), bgColor: (s.cardMeta?.bgColor as string) || undefined }));
}

/** Whether a notebook holds anything but cards — ink, text, images, a
 *  flowchart. (A CARDS notebook with nothing else in it can simply
 *  stand empty; one with more is kept in the Inbox: cards/card-home-rescue.js.) */
export function hasNonCardShapes(shapes: Shape[]): boolean {
  return shapes.some((s) => !isCardShape(s));
}

export const GRID_GAP = 24;
export const GRID_COLUMNS = 4;

/**
 * The first free slot in a grid of default-sized cards starting at
 * `origin`: the next card Courier sends lands beside the last one, and a
 * card the user has since moved leaves its slot free again.
 */
export function freeCardSlot(shapes: Shape[], origin: Point, columns = GRID_COLUMNS): Point {
  const boxes = shapes.filter(isCardShape).map(cardBounds);
  const w = CARD_DEFAULT_WIDTH + GRID_GAP;
  const h = CARD_DEFAULT_HEIGHT + GRID_GAP;
  for (let n = 0; n < 10000; n++) {
    const x = origin.x + (n % columns) * w;
    const y = origin.y + Math.floor(n / columns) * h;
    const hit = boxes.some((b) => b.minX < x + CARD_DEFAULT_WIDTH && b.maxX > x
      && b.minY < y + CARD_DEFAULT_HEIGHT && b.maxY > y);
    if (!hit) return { x, y };
  }
  return { x: origin.x, y: origin.y };
}
