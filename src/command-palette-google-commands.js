/**
 * Google Docs command palette entries — split out of
 * `command-palette-commands.js` to keep that file under the 700-line cap,
 * the same shape `command-palette-desk-commands.js` uses: the builder
 * returns plain descriptors and the caller spreads them into its list in
 * place, so ordering in the palette is unchanged.
 *
 * "Remove all Comments" rides along with them: the comment syntax it
 * strips is what a pulled Google Doc leaves behind in the buffer.
 */

import { isCommentsHidden } from "./google-docs/comments-visibility.js";

/** Lazy-import a Google Docs link-command and return an action fn that
 *  surfaces auth/API errors via window.alert (cheap, accessible). */
function _gdocAction(method) {
  return (s) => import("./google-docs/link-command.js")
    .then((m) => m[method](s))
    .catch((e) => { if (e) { console.error("[google-docs]", e); window.alert(e.message || String(e)); } });
}

export function buildGoogleCommands({ icons }) {
  return [
    { id: "google-import", label: "Import from Google Doc", icon: icons.export, shortcutKey: null, ctx: "shared", action: _gdocAction("importFromGoogleDoc") },
    { id: "google-link", label: "Link Document to Google Doc", icon: icons.export, shortcutKey: null, ctx: "doc",
      hiddenIf: (s) => !!s.settings?.googleDocLinks?.[s.currentFileId], action: _gdocAction("linkCurrentDocument") },
    { id: "google-create-from-current", label: "Create Google Doc from current", icon: icons.export, shortcutKey: null, ctx: "doc",
      hiddenIf: (s) => !!s.settings?.googleDocLinks?.[s.currentFileId], action: _gdocAction("createGoogleDocFromCurrent") },
    { id: "google-unlink", label: "Unlink Document from Google Doc", icon: icons.trash, shortcutKey: null, ctx: "doc",
      hiddenIf: (s) => !s.settings?.googleDocLinks?.[s.currentFileId], action: _gdocAction("unlinkCurrentDocument") },
    { id: "google-hide-comments", label: "Google : Hide comments", icon: icons.export, shortcutKey: null, ctx: "doc",
      hiddenIf: (s) => !s.settings?.googleDocLinks?.[s.currentFileId] || isCommentsHidden(s.currentFileId),
      action: _gdocAction("hideGoogleComments") },
    { id: "google-show-comments", label: "Google : Show comments", icon: icons.export, shortcutKey: null, ctx: "doc",
      hiddenIf: (s) => !s.settings?.googleDocLinks?.[s.currentFileId] || !isCommentsHidden(s.currentFileId),
      action: _gdocAction("showGoogleComments") },
    { id: "remove-all-comments", label: "Remove all Comments", icon: icons.trash, shortcutKey: null, ctx: "doc",
      hiddenIf: (s) => !/\{>[\s\S]*?<[A-Za-z0-9]+\}|^\[>[A-Za-z0-9]+\]:/m.test(s.editor?.view?.state?.doc?.toString() || ""),
      action: async (s) => {
        const view = s.editor?.view;
        if (!view) return;
        const { stripCommentSyntax } = await import("./editor/comment-syntax.js");
        const text = view.state.doc.toString();
        const cleaned = stripCommentSyntax(text);
        if (cleaned === text) return;
        view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: cleaned } });
        s.markDirty?.();
        await s.saveCurrentFile?.();
      } },
  ];
}
