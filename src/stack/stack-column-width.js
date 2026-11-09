/**
 * The width a stack column is *drawn* at, which on a phone is not always
 * the width it is stored at.
 *
 * A column's width rides the `.hushstack` file (500–800 px is typical,
 * set on a Mac or iPad), and on an iPhone that is wider than the screen:
 * every column ran off the right edge and the text was cut mid-line. On
 * a phone a column is drawn no wider than the screen less the stack's
 * left gutter and the spine, so one column is one screen. The stored
 * width is left alone — the same stack opened on the Mac keeps its
 * layout — and everything that lays columns out or measures them
 * (virtualisation, the scrollbar pills, reorder) reads this rather than
 * `item.width`, so what is measured is what is drawn.
 */
export const SPINE_WIDTH = 50;
export const DEFAULT_COLUMN_WIDTH = 800;

/** The stack's left gutter on a phone — `#stack-container`'s `left` in
 *  phone.css, which clears the files sidebar's toggle circle. */
const PHONE_LEFT_GUTTER = 52;
const MIN_PHONE_COLUMN = 200;

function phoneLayout() {
  return typeof document !== "undefined" && document.documentElement.classList.contains("phone");
}

/** Content width (spine excluded) a horizontal column is drawn at. */
export function columnDisplayWidth(item) {
  const stored = item.width || DEFAULT_COLUMN_WIDTH;
  if (!phoneLayout()) return stored;
  const room = (typeof window !== "undefined" ? window.innerWidth : stored) - PHONE_LEFT_GUTTER - SPINE_WIDTH;
  return Math.min(stored, Math.max(MIN_PHONE_COLUMN, room));
}
