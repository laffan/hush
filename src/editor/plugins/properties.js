/**
 * Properties (metadata frontmatter) plugin.
 *
 * Docs that start with a `---` frontmatter block get Obsidian-style
 * "Properties" treatment:
 *
 *   - Hidden by default: the block collapses to nothing (an inline
 *     replace decoration) and is protected from stray edits — deletions
 *     that overlap it are suppressed, and text typed at the very top of
 *     the doc is re-routed to just after the block.
 *   - "View properties" (Cmd+; / command palette) swaps the raw YAML for
 *     an integrated editing UI (see properties-widget.js) rendered as a
 *     block widget at the top of the document. Edits in the UI are
 *     serialized back into the frontmatter text as normal user edits
 *     (dirty flag, autosave, undo history all apply).
 *   - Frontmatter whose YAML falls outside the supported subset is left
 *     as raw editable text while properties are visible, so nothing the
 *     UI can't represent is ever locked away or rewritten.
 *
 * The visible/hidden flag is app-global (`settings.propertiesVisible`)
 * and persisted; `togglePropertiesVisibility` flips it and refreshes
 * every live editor view.
 */

import { EditorView, Decoration, WidgetType, ViewPlugin } from "@codemirror/view";
import { EditorState, StateField, StateEffect, Annotation, RangeSet } from "@codemirror/state";
import {
  findFrontmatterRange, parseProperties, FRONTMATTER_SCAN_LIMIT,
} from "../frontmatter.js";
// Circular at module level (base-extensions imports this plugin), but
// `programmaticChange` is only read at dispatch time, long after both
// modules have finished evaluating.
import { programmaticChange } from "../base-extensions.js";
import { buildPropertiesDOM } from "./properties-widget.js";

/** Marks a dispatch that came from the properties UI itself — exempt
 *  from the frontmatter edit protection below. */
export const propertiesEdit = Annotation.define();

/** Forces the decoration field to recompute (visibility toggled). */
const propertiesRefresh = StateEffect.define();

// Every live view running the plugin, so a visibility toggle can reach
// panes and cached editors as well as the main editor.
const propertyViews = new Set();

export function isPropertiesVisible(appState) {
  return !!appState?.settings?.propertiesVisible;
}

/** Dispatch a refresh into every registered view. */
export function refreshPropertiesViews() {
  for (const view of propertyViews) {
    try { view.dispatch({ effects: propertiesRefresh.of(null) }); } catch (_) { /* view mid-teardown */ }
  }
}

/** Flip the app-global properties visibility, persist it, and refresh
 *  all editors. Returns the new value. */
export async function togglePropertiesVisibility(appState) {
  const next = !isPropertiesVisible(appState);
  if (!next) {
    // Hiding tears the widgets down — flush any half-typed edits first.
    for (const view of propertyViews) {
      try { view.dom.querySelector(".cm-properties")?.__commitPending?.(); } catch (_) { /* noop */ }
    }
  }
  await appState.updateSettings({ propertiesVisible: next });
  refreshPropertiesViews();
  return next;
}

/** Palette "Add property": make properties visible if they aren't, then
 *  open a fresh row in the main editor's properties UI. */
export async function addPropertyFromPalette(appState) {
  if (!isPropertiesVisible(appState)) await togglePropertiesVisibility(appState);
  const view = appState.editor?.view;
  if (!view) return;
  requestAnimationFrame(() => {
    const el = view.dom.querySelector(".cm-properties");
    el?.__addPropertyRow?.();
  });
}

/** Slice just the head of the doc — frontmatter never lives past the
 *  scan limit, and `toString()` on a big doc every keystroke would hurt. */
function docHead(doc) {
  return doc.sliceString(0, Math.min(doc.length, FRONTMATTER_SCAN_LIMIT));
}

class PropertiesWidget extends WidgetType {
  /**
   * @param {string} text    The exact frontmatter block text (delimiters
   *   included) this widget represents; "" for the draft (no-frontmatter)
   *   state. Used for identity so unrelated doc edits don't rebuild the UI.
   * @param {Array}  entries Parsed property entries.
   */
  constructor(text, entries) {
    super();
    this.text = text;
    this.entries = entries;
  }

  eq(other) { return other.text === this.text; }

  toDOM(view) {
    return buildPropertiesDOM(view, this.entries, this.text, propertiesEdit);
  }

  // After the UI commits an edit, the field rebuilds and hands us the
  // widget's own serialization back. The live DOM already shows it
  // (it produced it), so keep the element — this is what preserves
  // input focus across commits. External rewrites (sync, panes) won't
  // match and rebuild the UI from the doc.
  updateDOM(dom) {
    return dom.dataset?.fmText === this.text;
  }

  ignoreEvent() { return true; }
}

/** Tracks live views so visibility toggles can reach all of them. */
const registrar = ViewPlugin.fromClass(
  class {
    constructor(view) {
      this.view = view;
      propertyViews.add(view);
    }
    destroy() {
      propertyViews.delete(this.view);
    }
  }
);

/**
 * Create the properties extension bundle for one editor.
 * Reads `appState.settings.propertiesVisible` live.
 */
export function createPropertiesPlugin(appState) {
  const visible = () => isPropertiesVisible(appState);

  function buildDeco(edState) {
    const head = docHead(edState.doc);
    const fm = findFrontmatterRange(head);
    if (!fm) {
      // No frontmatter. While properties are visible, offer the
      // integrated "Add property" UI so a block can be created without
      // hand-typing delimiters.
      if (!visible()) return Decoration.none;
      const widget = new PropertiesWidget("", []);
      return RangeSet.of([Decoration.widget({ widget, side: -1, block: true }).range(0)]);
    }
    if (!visible()) {
      // Collapse the block and the newline that glues it to the body.
      const end = edState.doc.length > fm.to ? fm.to + 1 : fm.to;
      return RangeSet.of([Decoration.replace({}).range(0, end)]);
    }
    const entries = parseProperties(head.slice(fm.contentFrom, fm.contentTo));
    // Unsupported YAML: leave the raw block visible and editable.
    if (!entries) return Decoration.none;
    const widget = new PropertiesWidget(head.slice(0, fm.to), entries);
    return RangeSet.of([Decoration.replace({ widget, block: true }).range(0, fm.to)]);
  }

  const field = StateField.define({
    create: buildDeco,
    update(value, tr) {
      if (tr.docChanged || tr.effects.some((e) => e.is(propertiesRefresh))) {
        return buildDeco(tr.state);
      }
      return value;
    },
    provide: (f) => EditorView.decorations.from(f),
  });

  // Cursor motion skips over the collapsed / widget-replaced block.
  const atomic = EditorView.atomicRanges.of((view) => view.state.field(field));

  /** The frontmatter range to protect in `tr.startState`, or null when
   *  edits should flow through untouched. */
  function protectedRange(tr) {
    if (!tr.docChanged) return null;
    if (tr.annotation(propertiesEdit)) return null;
    // Undo/redo must be able to restore frontmatter text, and app-driven
    // rewrites (file load, sync apply, pane mirror) own the whole buffer.
    if (tr.isUserEvent("undo") || tr.isUserEvent("redo")) return null;
    if (tr.annotation(programmaticChange)) return null;
    const doc = tr.startState.doc;
    const head = docHead(doc);
    const fm = findFrontmatterRange(head);
    if (!fm) return null;
    // Raw-editing mode: visible but unsupported YAML.
    if (visible() && !parseProperties(head.slice(fm.contentFrom, fm.contentTo))) return null;
    return { from: 0, to: doc.length > fm.to ? fm.to + 1 : fm.to };
  }

  // Suppress user edits that overlap the frontmatter block (the rest of
  // the change set still applies — select-all + delete clears the body
  // and keeps the properties).
  const guard = EditorState.changeFilter.of((tr) => {
    const range = protectedRange(tr);
    return range ? [range.from, range.to] : true;
  });

  // A boundary insertion at position 0 slips past the change filter but
  // would land text *above* the `---` line, silently demoting the block
  // to body text. Re-route a plain top-of-doc insertion to just after
  // the block instead — where the user visually intended it.
  const topInsertReroute = EditorState.transactionFilter.of((tr) => {
    const range = protectedRange(tr);
    if (!range) return tr;
    let single = null;
    let count = 0;
    tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
      count++;
      single = { fromA, toA, inserted };
    });
    if (count !== 1 || single.fromA !== 0 || single.toA !== 0) return tr;
    const pos = range.to;
    return {
      changes: { from: pos, to: pos, insert: single.inserted },
      selection: { anchor: pos + single.inserted.length },
      annotations: propertiesEdit.of(true),
      scrollIntoView: true,
    };
  });

  return [field, atomic, guard, topInsertReroute, registrar];
}
