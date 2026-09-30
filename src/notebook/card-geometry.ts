/**
 * A card's box on the canvas: its position is the top-left corner, its
 * size comes from its metadata (300 × 100 unless resized), and a
 * collapsed card is only its header. Kept apart from `card-shape.ts` so
 * `utils.ts#getShapeBounds` can read it without an import cycle.
 */
import type { Bounds, TextShape } from "./types";
import { cardSize, CARD_HEADER_HEIGHT } from "../cards/card-model";

export function cardBox(shape: TextShape): { x: number; y: number; width: number; height: number } {
  const { width, height } = cardSize(shape.cardMeta);
  return {
    x: shape.position.x,
    y: shape.position.y,
    width,
    height: shape.cardMeta?.collapsed ? CARD_HEADER_HEIGHT : height,
  };
}

export function cardBounds(shape: TextShape): Bounds {
  const b = cardBox(shape);
  return { minX: b.x, minY: b.y, maxX: b.x + b.width, maxY: b.y + b.height };
}
