/**
 * Private mode — two different jobs, and deliberately two different
 * mechanisms.
 *
 * 1. **"blackout"** paints opaque bars over whatever words are on screen.
 *    It is a `layer()` (the same machinery `drawSelection` uses), not a
 *    decoration: a decoration has to wrap characters in elements, and
 *    wrapping every character in its own span costs the run its kerning
 *    and its ligatures, so the text got measurably *wider* and re-wrapped
 *    the moment privacy came on — the document grew a few lines and
 *    everything below the fold moved. A layer draws rectangles at
 *    measured coordinates and never touches the text, so turning privacy
 *    on and off is a repaint with no reflow at all. It also costs work
 *    proportional to what is *visible*, not to the length of the
 *    document, which is what makes it usable on a long piece.
 *
 *    One rect per run of non-whitespace — a word — rather than per line,
 *    because the gaps between words are the shape of the writing, and
 *    seeing the rhythm of your own paragraphs is the point of the mode.
 *
 * 2. **"dummy"** substitutes a stand-in character for each real one, so
 *    it *has* to reach the glyphs and stays a per-character decoration.
 *
 * Both run off `createBaseExtensions`, so floating panes, stack columns
 * and the Zen / Selection-Focus overlays are covered by the same pass as
 * the main editor — privacy that stopped at `#editor-container` left
 * every other surface on screen readable, which is the one thing the
 * mode must not do.
 */
import { ViewPlugin, Decoration, layer, RectangleMarker } from "@codemirror/view";
import { RangeSetBuilder, StateEffect, EditorSelection } from "@codemirror/state";

/** Dispatched into every live view when privacy is toggled from outside
 *  the editor (the command palette, the shortcut, a settings change) —
 *  neither the layer nor the plugin sees a transaction otherwise, so the
 *  bars would only appear on the user's next keystroke. */
const privacyRefresh = StateEffect.define();

/** A pathological line (minified JSON, a base64 blob) could ask for tens
 *  of thousands of rects. The cap keeps one bad paste from stalling the
 *  measure pass; past it the remaining words are covered by the
 *  transparent-text rule alone. */
const MAX_BARS = 4000;

function privacyModeOf(stateRef) {
  return stateRef.settings.privacyMode || "blackout";
}

function blackoutActive(stateRef) {
  return !!stateRef.privateMode && privacyModeOf(stateRef) === "blackout";
}

/** Word rects for everything currently rendered. Walks `visibleRanges`
 *  only, so a fifty-page document costs the same as a one-page one. */
function blackoutMarkers(view, stateRef) {
  if (!blackoutActive(stateRef)) return [];
  const out = [];
  const doc = view.state.doc;
  for (const { from, to } of view.visibleRanges) {
    let pos = from;
    while (pos <= to) {
      const line = doc.lineAt(pos);
      const start = Math.max(line.from, from);
      const end = Math.min(line.to, to);
      let runStart = -1;
      for (let i = start; i <= end; i++) {
        const ch = i < line.to ? line.text[i - line.from] : " ";
        const blank = i >= end || ch === " " || ch === "\t";
        if (!blank) {
          if (runStart < 0) runStart = i;
        } else if (runStart >= 0) {
          for (const m of RectangleMarker.forRange(
            view, "hush-privacy-bar", EditorSelection.range(runStart, i),
          )) out.push(m);
          runStart = -1;
          if (out.length >= MAX_BARS) return out;
        }
      }
      if (line.to >= to) break;
      pos = line.to + 1;
    }
  }
  return out;
}

/** The layer re-measures on its own whenever the document view is
 *  redrawn (which covers scrolling and re-wrapping); this signature
 *  catches the toggles that change *whether* it should draw at all, and
 *  keeps `settings-changed` — which fires for every setting in the app —
 *  from poking a transaction into every open surface. */
function privacySignature(stateRef) {
  return `${stateRef.privateMode ? 1 : 0}:${privacyModeOf(stateRef)}:` +
    `${(stateRef.settings.dummyText || "").length}`;
}

export function createPrivacyLayer(stateRef) {
  let lastSig = privacySignature(stateRef);
  let dom = null;
  // The fade lives on the layer's own element, not on the bars: a
  // per-bar blur animation would put a few hundred filtered layers on
  // the compositor at once, where one filter on the container that holds
  // them all is a single composited pass. Only the way IN is animated —
  // when privacy comes off, the markers go with it in the same measure
  // pass, and the text underneath is revealed instantly anyway.
  const syncOn = () => { if (dom) dom.classList.toggle("is-on", blackoutActive(stateRef)); };
  return layer({
    above: true,
    class: "hush-privacy-layer",
    mount(el) { dom = el; syncOn(); },
    destroy() { dom = null; },
    update(update) {
      const sig = privacySignature(stateRef);
      const toggled = sig !== lastSig;
      lastSig = sig;
      if (toggled) syncOn();
      // Deliberately NOT on selection changes: re-measuring every word
      // rect costs a coordinate lookup apiece, and moving the caret
      // moves no words.
      return toggled || update.docChanged || update.viewportChanged ||
        update.geometryChanged;
    },
    markers: (view) => blackoutMarkers(view, stateRef),
  });
}

/**
 * Dummy mode: each LINE gets a stable offset into the dummy text based
 * on its line number (lineNum * 997, a large prime).  Within the line,
 * characters advance sequentially from that offset.
 *
 * Editing on line N only shifts dummy chars on line N.
 * All other lines stay completely stable.
 */
function buildDummyDecorations(view, dummyText) {
  const builder = new RangeSetBuilder();
  const dummyLen = dummyText.length;
  if (dummyLen === 0) return Decoration.none;
  const doc = view.state.doc;

  for (const { from, to } of view.visibleRanges) {
    let pos = from;
    while (pos <= to) {
      const line = doc.lineAt(pos);
      const lineStart = Math.max(line.from, from);
      const lineEnd = Math.min(line.to, to);
      const lineOffset = (line.number * 997) % dummyLen;
      const lineText = line.text;

      for (let i = lineStart; i <= lineEnd; i++) {
        const chIdx = i - line.from;
        if (chIdx >= lineText.length) break;
        if (lineText[chIdx] === "\n") continue;
        const dummyChar = dummyText[(lineOffset + chIdx) % dummyLen];
        builder.add(i, i + 1, Decoration.mark({
          class: "hush-dummy-char",
          attributes: { "data-dummy": dummyChar },
        }));
      }
      pos = line.to + 1;
    }
  }
  return builder.finish();
}

function buildDecorations(view, stateRef) {
  if (!stateRef.privateMode) return Decoration.none;
  if (privacyModeOf(stateRef) !== "dummy") return Decoration.none;
  if (!stateRef.settings.dummyText) return Decoration.none;
  return buildDummyDecorations(view, stateRef.settings.dummyText);
}

export function createPrivateModePlugin(stateRef) {
  return ViewPlugin.fromClass(
    class {
      constructor(view) {
        this.decorations = buildDecorations(view, stateRef);
        // Toggling privacy happens outside CodeMirror, so nothing would
        // otherwise redraw a pane or an overlay that isn't being typed
        // in. A microtask, not a synchronous dispatch: `settings-changed`
        // can be emitted from inside another view's update, and a
        // re-entrant dispatch throws.
        this._sig = privacySignature(stateRef);
        this._sync = () => {
          const sig = privacySignature(stateRef);
          if (sig === this._sig) return;
          this._sig = sig;
          queueMicrotask(() => {
            try { view.dispatch({ effects: privacyRefresh.of(null) }); }
            catch { /* view torn down between the emit and the microtask */ }
          });
        };
        stateRef.on("mode-changed", this._sync);
        stateRef.on("settings-changed", this._sync);
      }

      update(update) {
        this.decorations = buildDecorations(update.view, stateRef);
      }

      destroy() {
        stateRef.off("mode-changed", this._sync);
        stateRef.off("settings-changed", this._sync);
      }
    },
    {
      decorations: (v) => v.decorations,
    }
  );
}

/** Both halves, for the shared extension list. */
export function createPrivacyExtensions(stateRef) {
  return [createPrivateModePlugin(stateRef), createPrivacyLayer(stateRef)];
}
