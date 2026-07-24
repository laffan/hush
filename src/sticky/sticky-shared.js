/**
 * Sticky-note shared constants + pure helpers — extracted from
 * sticky-notes.js (700-line cap): sizing/font clamps, the scope glyphs,
 * the collapsed-header excerpt, and the Desktop-pinning hooks.
 */

export const DEFAULT_SIZE = 300;
export const MAX_SIZE = 300;
export const MIN_SIZE = 120;
export const HEADER_HEIGHT = 35;
export const MIN_FONT = 10;
export const MAX_FONT = 48;
export const FONT_STEP = 2;
export const DEFAULT_FONT = 21;

export const ICON_CLOSE = `<svg viewBox="0 0 10 10"><line x1="2" y1="2" x2="8" y2="8"/><line x1="8" y1="2" x2="2" y2="8"/></svg>`;

// Context glyphs. The note's coloured body already signals the scope, so
// the header shows just this small button — the document (file), desk, or
// globe (app) glyph — and clicking it opens a menu to change the scope.
// Reuse the sidebar's document + writing-desk glyphs so the iconography
// reads the same across the app.
export const CTX_ICON = {
  file: `<svg viewBox="0 0 16 16"><line x1="4" y1="4" x2="12" y2="4"/><line x1="4" y1="8" x2="12" y2="8"/><line x1="4" y1="12" x2="9" y2="12"/></svg>`,
  desktop: `<svg viewBox="0 0 16 16"><rect x="2" y="2" width="5" height="5" rx="0.8" fill="none"/><rect x="9" y="2" width="5" height="5" rx="0.8" fill="none"/><rect x="2" y="9" width="5" height="5" rx="0.8" fill="none"/><rect x="9" y="9" width="5" height="5" rx="0.8" fill="none"/></svg>`,
  desk: `<svg viewBox="0 0 24 24"><path d="M4 7L4 17"/><path d="M1 7L23 7"/><path d="M14 14H20"/><path d="M20 7L20 17"/><path d="M14 7L14 17"/></svg>`,
  global: `<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="6"/><line x1="2" y1="8" x2="14" y2="8"/><ellipse cx="8" cy="8" rx="3" ry="6"/></svg>`,
};

// The context switcher offers exactly these three scopes. Project stickies
// (created from the palette) keep working and borrow the document glyph.
export const CTX_MENU = [
  { key: "file", label: "Document" },
  { key: "desk", label: "Desk" },
  { key: "global", label: "App" },
];

export function ctxIconFor(kind) {
  if (kind === "desktop") return CTX_ICON.desktop;
  return CTX_ICON[kind === "project" ? "file" : kind] || CTX_ICON.global;
}

/** First few words of the note body, on one line — shown in the header
 *  only while the note is collapsed so the user can tell stickies apart
 *  without expanding them. Kept short so it never crowds the buttons. */
export function excerptFor(text) {
  const t = (text || "").replace(/\s+/g, " ").trim();
  if (!t) return "";
  return t.length > 42 ? t.slice(0, 42).trimEnd() + "…" : t;
}

/** The project whose Desktop takeover is currently open, or null.
 *  (Set by desktop-view.js — drives the desktop-pinned sticky scope.) */
export function desktopOpenId() {
  return (typeof window !== "undefined" && window.__hushDesktopOpenId) || null;
}

/** Live zoom of the open Desktop's canvas (1 when none is open). Rides
 *  the world→screen hook so there's only one bridge to keep in sync. */
export function desktopZoom() {
  const toScreen = typeof window !== "undefined" ? window.__hushDesktopWorldToScreen : null;
  const p = toScreen ? toScreen({ x: 0, y: 0 }) : null;
  return p && typeof p.zoom === "number" && p.zoom > 0 ? p.zoom : 1;
}

export function clampAxis(requested, size, viewport) {
  const max = Math.max(0, viewport - size);
  return Math.min(max, Math.max(0, requested));
}

export function clampSize(size) {
  const n = typeof size === "number" && isFinite(size) ? size : DEFAULT_SIZE;
  return Math.min(MAX_SIZE, Math.max(MIN_SIZE, Math.round(n)));
}

export function clampFont(size) {
  const n = typeof size === "number" && isFinite(size) ? size : DEFAULT_FONT;
  return Math.min(MAX_FONT, Math.max(MIN_FONT, Math.round(n)));
}
