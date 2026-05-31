/**
 * Inline panes — pinned floating panes that live *inside* the doc text,
 * anchored to a `[[wikilink]]` occurrence. Clicking the small `▾` arrow
 * on a rendered wikilink opens a pane embedded just below that line; the
 * doc text below shifts down to make room. Resizing the pane resizes
 * the space it reserves; closing collapses the space; dragging the title
 * bar detaches the pane into a normal floating pane (at which point the
 * doc column starts making lateral space for it again).
 *
 * Implementation notes:
 *
 *   - Each inline pane carries `pane.inline = { anchorTitle, occurrence,
 *     height }` (plus the usual ownerContext). The pane lives in the
 *     global `panes` Map and looks normal to most of the pane subsystem;
 *     the CM plugin below treats those records as block-widget
 *     decorations anchored at the end of the line that contains the Nth
 *     matching `[[Title]]`.
 *
 *   - The block widget DOM hosts `pane.el` directly — pane chrome,
 *     editor, resize handles all render inside the widget. CodeMirror
 *     measures the widget's height naturally, so doc text below reflows
 *     when the user resizes. The widget's `eq()` is keyed on pane id so
 *     CM reuses the same DOM across updates rather than tearing the
 *     editor down and rebuilding it on every keystroke.
 *
 *   - Pane.x/y are ignored while inline; on detach we read the live
 *     position from `pane.el.getBoundingClientRect()` and reparent the
 *     element back into `#pane-container`.
 */

import { ViewPlugin, Decoration, WidgetType, EditorView } from "@codemirror/view";
import { RangeSetBuilder, StateField, StateEffect } from "@codemirror/state";
import { resolveWikilink } from "../links/wikilink-index.js";
import { panes } from "./pane-state.js";

export const DEFAULT_INLINE_HEIGHT = 500;
// All `[[…]]` matches scanned the same way the wikilink decorator does so
// occurrence indices line up across the two plugins.
const WIKILINK_RE = /\[\[([^\[\]\n]+?)\]\]/g;

/** Compute the same context id that `pane-manager.getCurrentContext` uses
 *  for the active doc. Inline panes live inside docs only, so we read
 *  `currentFileId` and prefix it the same way. Returns null when we're
 *  not in a doc context (notebook / pdf / stack), which is when the
 *  inline plugin disables itself. */
export function getDocContext(appState) {
  if (!appState) return null;
  if (appState.currentStackFileId) return null;
  if (appState.currentPdfFileId) return null;
  if (appState.currentNotebookFileId) return null;
  if (appState.currentProjectId) return "pj:" + appState.currentProjectId;
  if (appState.currentFileId) return "doc:" + appState.currentFileId;
  return null;
}

/** Open an inline pane for a wikilink in the active doc. Called by the
 *  wikilink decorator's arrow-button click handler. Resolves the
 *  wikilink, refuses to open a second inline pane for the same anchor
 *  occurrence (focuses the existing one instead), and otherwise mints a
 *  fresh pane via the pane manager with `opts.inline` set. */
export async function openInlinePaneForWikilink(appState, { title, occurrence }) {
  const note = resolveWikilink(appState, title);
  if (!note) return;
  const ctx = getDocContext(appState);
  if (!ctx) return;
  const { focusPane, createPane } = await import("./pane-manager.js");
  // De-dupe: one inline pane per (doc, title, occurrence).
  for (const [, p] of panes) {
    if (!p.inline) continue;
    if (p.ownerContext !== ctx) continue;
    if (p.inline.anchorTitle.toLowerCase() !== title.toLowerCase()) continue;
    if ((p.inline.occurrence | 0) !== (occurrence | 0)) continue;
    focusPane(p.id);
    return;
  }
  await createPane(note.fileId, note.name, note.type, 0, 0, {
    ownerContext: ctx,
    allowDuplicate: true,
    skipFocus: false,
    inline: {
      anchorTitle: title,
      occurrence: occurrence | 0,
      height: DEFAULT_INLINE_HEIGHT,
    },
  });
}

/** Locate the Nth `[[title]]` occurrence in the doc and return the offset
 *  immediately after the end of the line containing it. Returns null when
 *  the doc no longer contains that many matches (the user may have
 *  deleted the link). The plugin uses this to position block widgets. */
function findAnchorPos(doc, title, occurrence) {
  const targetLower = title.toLowerCase();
  let seen = 0;
  for (let i = 1; i <= doc.lines; i++) {
    const line = doc.line(i);
    WIKILINK_RE.lastIndex = 0;
    let match;
    while ((match = WIKILINK_RE.exec(line.text)) !== null) {
      const t = match[1].trim();
      if (!t) continue;
      if (t.toLowerCase() !== targetLower) { continue; }
      if (seen === occurrence) return line.to;
      seen++;
    }
  }
  return null;
}

class InlinePaneWidget extends WidgetType {
  constructor(paneId, host) {
    super();
    this.paneId = paneId;
    // `host` is the DOM element that holds `pane.el`. Stable across
    // rebuilds so CM doesn't rip the editor out on every doc change.
    this.host = host;
  }

  // Stable identity per pane id — CM reuses the same DOM (and therefore
  // keeps `pane.el` mounted) across rebuilds. Height changes are picked
  // up via `view.requestMeasure()` from `syncInlinePaneSize`.
  eq(other) { return this.paneId === other.paneId; }

  toDOM() { return this.host; }

  ignoreEvent() { return false; }

  // We hand back the same DOM node each time, so CM doesn't need to
  // rebuild it; returning true tells CM the existing DOM is still valid.
  updateDOM(_dom) { return true; }
}

/** Effect dispatched whenever an external event (panes-changed,
 *  files-changed, file-opened) requires the inline-pane decoration set
 *  to be rebuilt. CodeMirror block decorations can only be provided
 *  through a StateField, so external rebuilds piggyback on a no-op
 *  transaction carrying this effect. */
const inlinePaneRebuildEffect = StateEffect.define();

/** Build the block-widget decoration set for every inline pane whose
 *  `ownerContext` matches the active doc. Each widget is anchored at the
 *  end of the line containing the Nth `[[Title]]` match and hosts the
 *  pane's DOM element directly. */
function buildInlineDecorations(doc, appState) {
  const ctx = getDocContext(appState);
  if (!ctx) return Decoration.none;
  // Sort by anchor pos so RangeSetBuilder gets ranges in order.
  const entries = [];
  for (const [, pane] of panes) {
    if (!pane.inline) continue;
    if (pane.ownerContext !== ctx) continue;
    if (!pane.el) continue;
    const pos = findAnchorPos(doc, pane.inline.anchorTitle, pane.inline.occurrence | 0);
    if (pos == null) continue;
    entries.push({ pos, pane });
  }
  entries.sort((a, b) => a.pos - b.pos);
  const builder = new RangeSetBuilder();
  for (const { pos, pane } of entries) {
    // Ensure the host wrapper exists. The pane.el lives inside it so
    // CM can reuse the same DOM node across rebuilds.
    let host = pane._inlineHost;
    if (!host) {
      host = document.createElement("div");
      host.className = "cm-inline-pane-host";
      host.dataset.paneId = pane.id;
      pane._inlineHost = host;
    }
    // Host carves out the vertical space (its `height` style is what CM
    // measures); pane.el is absolutely positioned inside so it can be
    // wider than the host without dragging the editor's column width
    // along for the ride. `overflow: visible` lets the pane bleed past
    // the column edges when the user makes it wider than the text.
    host.style.height = (pane.height || 500) + "px";
    if (pane.el && pane.el.parentNode !== host) {
      host.appendChild(pane.el);
    }
    if (pane.el) {
      pane.el.style.position = "absolute";
      pane.el.style.top = "0";
      pane.el.style.left = "50%";
      pane.el.style.transform = "translateX(-50%)";
      pane.el.style.margin = "";
      pane.el.style.width = pane.width + "px";
      pane.el.style.height = pane.height + "px";
    }
    builder.add(pos, pos, Decoration.widget({
      widget: new InlinePaneWidget(pane.id, host),
      block: true,
      side: 1,
    }));
  }
  return builder.finish();
}

/** Build the inline-pane extension set:
 *    - a StateField that owns the block-widget decoration set (CM 6
 *      forbids block decorations from ViewPlugins, so this is mandatory),
 *    - a ViewPlugin that subscribes to AppState events and pokes the
 *      field via `inlinePaneRebuildEffect` whenever an outside-the-doc
 *      change (a pane created, a file renamed, the active doc switched)
 *      could affect which inline panes belong on screen.
 */
export function createInlinePanePlugin(appState) {
  const field = StateField.define({
    create(state) { return buildInlineDecorations(state.doc, appState); },
    update(value, tr) {
      const externalRebuild = tr.effects.some((e) => e.is(inlinePaneRebuildEffect));
      if (tr.docChanged || externalRebuild) {
        return buildInlineDecorations(tr.state.doc, appState);
      }
      return value;
    },
    provide: (f) => EditorView.decorations.from(f),
  });

  const listener = ViewPlugin.fromClass(class {
    constructor(view) {
      this.view = view;
      this._onChange = () => {
        // Defer so listeners that fire during a CM update tick (e.g.
        // pane create called from a click handler) finish before we
        // dispatch into the same view.
        queueMicrotask(() => {
          if (!this.view) return;
          try {
            this.view.dispatch({ effects: inlinePaneRebuildEffect.of(null) });
          } catch {}
        });
      };
      appState?.on?.("panes-changed", this._onChange);
      appState?.on?.("files-changed", this._onChange);
      appState?.on?.("file-opened", this._onChange);
      appState?.on?.("inline-pane-resized", this._onChange);
    }
    destroy() {
      appState?.off?.("panes-changed", this._onChange);
      appState?.off?.("files-changed", this._onChange);
      appState?.off?.("file-opened", this._onChange);
      appState?.off?.("inline-pane-resized", this._onChange);
      this.view = null;
    }
  });

  return [field, listener];
}

/** Measure the live width of the main editor's text column so a fresh
 *  inline pane lands at column-width by default. Falls back to null
 *  when no editor is mounted yet (the caller substitutes a default). */
export function measureEditorColumnWidth() {
  const scroller = document.querySelector("#editor-container .cm-scroller");
  if (!scroller) return null;
  const cs = getComputedStyle(scroller);
  const padL = parseFloat(cs.paddingLeft) || 0;
  const padR = parseFloat(cs.paddingRight) || 0;
  const w = scroller.clientWidth - padL - padR;
  return w > 100 ? Math.round(w) : null;
}

/** Apply a new size to an inline pane. Width changes stay local to
 *  pane.el (host width is locked to the editor column so the doc
 *  column never reflows). Height changes propagate to the host so
 *  CM's measure pass sees the new vertical footprint and shifts the
 *  text below. Called from pane-drag's resize path. */
export function syncInlinePaneSize(pane, view) {
  if (!pane || !pane.inline) return;
  if (pane.el) {
    pane.el.style.height = pane.height + "px";
    pane.el.style.width = pane.width + "px";
  }
  if (pane._inlineHost) {
    pane._inlineHost.style.height = pane.height + "px";
  }
  try { view?.requestMeasure?.(); } catch {}
}

/** Reparent `pane.el` out of its inline host back to the floating-pane
 *  container, positioning it absolutely at the given screen coords.
 *  Clears `pane.inline` so subsequent metrics calls count it as a normal
 *  floating pane. Caller emits `panes-changed` so the inline CM plugin
 *  rebuilds without the now-detached pane. */
export function detachInlinePane(pane, containerEl, screenX, screenY) {
  if (!pane || !pane.inline) return;
  pane.inline = null;
  pane._inlineHost = null;
  if (pane.el) {
    pane.el.style.position = "absolute";
    // Clear the centered-in-host transform — once we're a normal
    // floating pane, x/y are the source of truth.
    pane.el.style.transform = "";
    pane.el.style.margin = "";
    pane.x = Math.max(0, Math.round(screenX));
    pane.y = Math.max(0, Math.round(screenY));
    pane.el.style.left = pane.x + "px";
    pane.el.style.top = pane.y + "px";
    pane.el.style.width = pane.width + "px";
    pane.el.style.height = pane.height + "px";
    // Strip the inline-pane class so the toolbar's normal chrome
    // (attach / pin / gutter) reveals through CSS.
    pane.el.classList.remove("inline-pane");
    if (containerEl && pane.el.parentNode !== containerEl) {
      containerEl.appendChild(pane.el);
    }
  }
}
