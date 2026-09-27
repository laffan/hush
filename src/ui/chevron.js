/**
 * The app's one chevron — the desk switcher's dropdown caret, and the
 * sidebar grip and Overview trigger pointing left / right. Same size,
 * same stroke, so the three read as one glyph turned to face its way.
 */

const POINTS = {
  down: "6 9 12 15 18 9",
  left: "15 6 9 12 15 18",
  right: "9 6 15 12 9 18",
};

export function chevronSvg(direction = "down") {
  return `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="${POINTS[direction] || POINTS.down}"/></svg>`;
}
