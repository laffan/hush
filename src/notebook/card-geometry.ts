/**
 * A card's box on the canvas: its position is the top-left corner, its
 * width comes from its metadata (300 unless resized), its height is the
 * one the card layer last measured its text at (`cardHeight`), and a
 * collapsed card is only its header. Kept apart from `card-shape.ts` so
 * `utils.ts#getShapeBounds` can read it without an import cycle.
 */
import type { Bounds, TextShape } from "./types";
import { cardSize, CARD_HEADER_HEIGHT, CARD_DEFAULT_HEIGHT, CARD_MIN_WIDTH } from "../cards/card-model";

export function cardBox(shape: TextShape): { x: number; y: number; width: number; height: number } {
  return {
    x: shape.position.x,
    y: shape.position.y,
    width: cardSize(shape.cardMeta).width,
    height: shape.cardMeta?.collapsed ? CARD_HEADER_HEIGHT : (shape.cardHeight || CARD_DEFAULT_HEIGHT),
  };
}

export function cardBounds(shape: TextShape): Bounds {
  const b = cardBox(shape);
  return { minX: b.x, minY: b.y, maxX: b.x + b.width, maxY: b.y + b.height };
}

/** A card resized by a canvas handle: only its width follows (its height
 *  is its words'), from the side the handle is on; its top stays put. */
export function resizedCard(shape: TextShape, fromLeft: boolean, orig: { minX: number; maxX: number }, newW: number): TextShape {
  const width = Math.max(CARD_MIN_WIDTH, Math.round(newW));
  return {
    ...shape,
    position: { x: fromLeft ? orig.maxX - width : orig.minX, y: shape.position.y },
    width,
    cardMeta: { ...(shape.cardMeta || {}), width },
  };
}
