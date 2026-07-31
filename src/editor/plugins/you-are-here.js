/**
 * YOUAREHERE editor support — two jobs, one plugin:
 *
 * 1. Decorate every literal `YOUAREHERE` (caps, no spaces) as a bright
 *    red rounded tag (`.cm-youarehere`).
 * 2. Enforce "one marker per buffer" at typing time: when an edit
 *    completes a NEW instance while another already exists, the older
 *    instance(s) are deleted in a follow-up (undoable) transaction.
 *    Cross-file / cross-shape enforcement lives in `src/you-are-here.js`
 *    and rides the save pipeline; this plugin handles the common case —
 *    typing a fresh marker into the doc that already holds one —
 *    instantly instead of on the next autosave.
 */
import { ViewPlugin, Decoration } from "@codemirror/view";
import { RangeSetBuilder } from "@codemirror/state";
// Circular at module level (base-extensions imports this plugin), but
// only the runtime value is used, so the live binding resolves fine.
import { programmaticChange } from "../base-extensions.js";
import { YAH_TOKEN, findMarkerOffsets } from "../../you-are-here.js";

const markDeco = Decoration.mark({ class: "cm-youarehere" });

export function createYouAreHerePlugin() {
  return ViewPlugin.fromClass(
    class {
      constructor(view) {
        this.decorations = this.buildDecorations(view);
      }

      update(update) {
        if (update.docChanged || update.viewportChanged) {
          this.decorations = this.buildDecorations(update.view);
        }
        if (update.docChanged) this.maybeDedup(update);
      }

      buildDecorations(view) {
        const builder = new RangeSetBuilder();
        const text = view.state.doc.toString();
        for (const o of findMarkerOffsets(text)) {
          builder.add(o, o + YAH_TOKEN.length, markDeco);
        }
        return builder.finish();
      }

      /** A user edit that brings the buffer to 2+ instances, at least
       *  one of which touches the inserted text, deletes every instance
       *  EXCEPT the newly-completed one. */
      maybeDedup(update) {
        const isProgrammatic = update.transactions.length > 0
          && update.transactions.every((tr) => tr.annotation(programmaticChange));
        if (isProgrammatic) return;
        const text = update.state.doc.toString();
        const offsets = findMarkerOffsets(text);
        if (offsets.length < 2) return;
        // Collect the inserted ranges of this update (in new-doc coords).
        const inserted = [];
        for (const tr of update.transactions) {
          tr.changes.iterChanges((fromA, toA, fromB, toB) => {
            inserted.push([fromB, toB]);
          });
        }
        if (!inserted.length) return;
        // The "new" instance is one whose span intersects an edit. An
        // insertion point falling inside/adjacent to the token counts —
        // typing the final E of YOUAREHERE inserts at its tail.
        const isNew = (o) => inserted.some(([f, t]) =>
          o <= t && (o + YAH_TOKEN.length) >= f);
        const fresh = offsets.filter(isNew);
        if (!fresh.length) return; // duplicates predate this edit — leave them
        const keep = fresh[fresh.length - 1];
        // Can't dispatch from inside update() — defer a tick, and
        // re-scan then so an interleaved transaction can't strand the
        // captured offsets on stale coordinates.
        const view = update.view;
        queueMicrotask(() => {
          try {
            const now = findMarkerOffsets(view.state.doc.toString());
            if (now.length < 2) return;
            const target = now.reduce((a, b) =>
              Math.abs(b - keep) < Math.abs(a - keep) ? b : a);
            const changes = now
              .filter((o) => o !== target)
              .map((o) => ({ from: o, to: o + YAH_TOKEN.length }));
            if (changes.length) view.dispatch({ changes, userEvent: "delete" });
          } catch (_) { /* view torn down */ }
        });
      }
    },
    { decorations: (v) => v.decorations }
  );
}
