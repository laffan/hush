/**
 * The palette's **Use Temporary Style**: a list of the styles (Default
 * first) to wear in the current context of the current document only —
 * the focused Doc pane, else the main editor — until the desk changes or
 * the app closes (state/temporary-style.js). The context's current style
 * is ticked, and once a temporary style is set the list leads with a row
 * that puts the usual one back.
 */
import { getActivePaneId } from "./pane/pane-manager.js";
import { panes } from "./pane/pane-state.js";
import {
  DEFAULT_STYLE, mainContextKey, paneContextKey, temporaryStyleFor, setTemporaryStyle, paneBaseSettings,
} from "./state/temporary-style.js";
import { findLockedStyleForFile } from "./pane/pane-locked-style.js";

/** The context the command acts on: `{ key, current }`, where `current`
 *  is the style id (null for Default) that context shows now; or null
 *  when no document has the keyboard. */
function targetContext(s) {
  const pane = panes.get(getActivePaneId());
  if (pane) {
    if (pane.fileType !== "document" || !pane.editor) return null;
    const key = paneContextKey(pane.id);
    const own = temporaryStyleFor(key) ?? findLockedStyleForFile(pane.fileId);
    const shown = own ? (own === DEFAULT_STYLE ? null : own) : paneBaseSettings(s.settings).activeStyleId;
    return { key, current: shown || null };
  }
  const key = mainContextKey(s);
  return key ? { key, current: s.settings.activeStyleId || null } : null;
}

function enterTemporaryStylePicker(palette, s, icon) {
  const ctx = targetContext(s);
  if (!ctx) return;
  const items = [];
  if (temporaryStyleFor(ctx.key) !== undefined) {
    items.push({
      id: "temp-style-clear", label: "Stop Using Temporary Style", icon, shortcutKey: null,
      action: () => setTemporaryStyle(s, ctx.key, undefined),
    });
  }
  const row = (id, name) => ({
    id: "temp-style-" + (id || "default"),
    label: name + ((id || null) === ctx.current ? " ✓" : ""),
    icon,
    shortcutKey: null,
    action: () => setTemporaryStyle(s, ctx.key, id || DEFAULT_STYLE),
  });
  items.push(row(null, "Default"));
  for (const st of s.settings?.styles || []) if (st?.id) items.push(row(st.id, st.name || "Untitled"));
  palette.setItems(items, "Use a style here until you switch desks…");
}

export function buildTemporaryStyleCommands({ icons }) {
  return [
    { id: "style-temporary", section: "Styles", label: "Use Temporary Style", icon: icons.styles, shortcutKey: null, ctx: "shared",
      keywords: "preview try session",
      keepOpen: true,
      hiddenIf: (s) => !targetContext(s),
      action: (s, p) => enterTemporaryStylePicker(p, s, icons.styles) },
  ];
}
