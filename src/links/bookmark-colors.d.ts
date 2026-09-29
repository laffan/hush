// Types for bookmark-colors.js, which the notebook bundle imports.
export const BOOKMARK_COLORS_EVENT: string;
export function setPdfBookmarkLookup(fn: (fileId: string) => { id: string; color?: string }[]): void;
export function pdfBookmarksChanged(): void;
export function publishNotebookBookmarks(fileId: string, bookmarks: { id: string; color: string }[]): void;
export function bookmarkLinkInfo(url: string): { color: string | null } | null;
