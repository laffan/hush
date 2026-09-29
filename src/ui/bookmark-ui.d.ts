// Types for the shared bookmark UI (bookmark-ui.js), which the notebook
// bundle imports.

interface Anchor { getBoundingClientRect(): DOMRect | { left: number; right: number; top: number; bottom: number; width: number; height: number } }

export const BOOKMARK_ICON: string;
export const BOOKMARK_COLORS: string[];
export const BOOKMARK_STAMP_CURSOR: string;
export function bookmarkGlyph(color: string, size?: number): string;
export function escHtml(str: string): string;
export function closeBookmarkPopup(): void;
export function isBookmarkPopupOpen(el?: Element): boolean;
export function pointAnchor(x: number, y: number): Anchor;
export function mountBookmarkPopup(el: HTMLElement, anchor: Anchor): void;
export function openBookmarkEditor(o: {
  anchor: Anchor; title: string; name?: string; color?: string; saveLabel: string;
  onSave: (name: string, color: string) => void; onDelete?: () => void;
}): void;
export function openBookmarkColorPalette(o: {
  anchor: Anchor; color?: string; onPick: (color: string) => void;
  actions?: { label: string; danger?: boolean; run: () => void }[];
}): void;
export function openBookmarkListPopup<T extends { id: string; name: string; color: string }>(o: {
  anchor: Anchor; key: string; getItems: () => T[];
  meta?: (bm: T) => string; onPick: (bm: T) => void;
  onEdit?: (bm: T, rowRect: DOMRect) => void;
  onDelete: (bm: T) => void | Promise<void>;
  linkText?: (bm: T) => string | null;
  onAdd?: () => void;
}): { rebuild(): void };
export function refreshBookmarkList(key: string): void;
export function startBookmarkStamp(key: string, onCancel?: () => void): void;
export function bookmarkStampKey(): string | null;
export function endBookmarkStamp(cancelled?: boolean): void;
export function startBookmarkLinkDrag(text: string, initialEvent: PointerEvent): Promise<void>;
