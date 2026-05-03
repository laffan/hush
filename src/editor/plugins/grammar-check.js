/**
 * Grammar check — opt-in green-wavy underline for issues flagged by the
 * `harper-core` Rust crate.
 *
 * The plugin keeps a cached array of `{ from, to, message, suggestions }`
 * issues per editor view, refreshed on a 1.5 s debounce after edits while
 * `state.grammarCheckActive` is on. The actual lint runs inside Rust so we
 * don't pay a JS-side cost or block input.
 *
 * Doc-only — notebooks intentionally aren't wired up.
 */
import { ViewPlugin, Decoration, hoverTooltip } from "@codemirror/view";
import { RangeSetBuilder, Annotation } from "@codemirror/state";

export const grammarRedecorate = Annotation.define();

const DEBOUNCE_MS = 1500;
const IS_TAURI = typeof window !== "undefined" && window.__TAURI_INTERNALS__;

/** Per-view cached issues plus the last text we ran against — used so a
 *  view that already ran on the current buffer doesn't redundantly call
 *  into Rust on a no-op transaction. */
const _viewState = new WeakMap();

async function runGrammarCheck(text) {
  if (!IS_TAURI) return [];
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const result = await invoke("check_grammar", { text });
    return Array.isArray(result) ? result : [];
  } catch (e) {
    console.warn("check_grammar failed:", e);
    return [];
  }
}

export function createGrammarCheckPlugin(stateRef) {
  return ViewPlugin.fromClass(
    class {
      constructor(view) {
        this.view = view;
        this._wasActive = !!stateRef.grammarCheckActive;
        this._timer = null;
        _viewState.set(view, { issues: [], lastText: null, runId: 0 });
        this.decorations = Decoration.none;
        if (stateRef.grammarCheckActive) this.scheduleCheck();
      }

      destroy() {
        if (this._timer) clearTimeout(this._timer);
        _viewState.delete(this.view);
      }

      update(update) {
        const active = !!stateRef.grammarCheckActive;
        const flipped = active !== this._wasActive;
        this._wasActive = active;

        const annot = update.transactions.some(
          (tr) => tr.annotation(grammarRedecorate),
        );

        if (!active && flipped) {
          // Just turned off — drop decorations, cancel any pending check.
          if (this._timer) { clearTimeout(this._timer); this._timer = null; }
          const s = _viewState.get(this.view);
          if (s) { s.issues = []; s.lastText = null; }
          this.decorations = Decoration.none;
          return;
        }

        if (active && (flipped || update.docChanged)) {
          this.scheduleCheck();
        }

        if (annot || update.viewportChanged || flipped) {
          this.decorations = this.buildDecorations();
        }
      }

      scheduleCheck() {
        if (this._timer) clearTimeout(this._timer);
        this._timer = setTimeout(() => { this.runCheckNow(); }, DEBOUNCE_MS);
      }

      async runCheckNow() {
        if (!stateRef.grammarCheckActive) return;
        const s = _viewState.get(this.view);
        if (!s) return;
        const text = this.view.state.doc.toString();
        if (text === s.lastText) return;
        const myRun = ++s.runId;
        const issues = await runGrammarCheck(text);
        // Bail if a newer run started while we were awaiting Rust, or the
        // toggle flipped off, or the view was torn down.
        if (myRun !== s.runId) return;
        if (!stateRef.grammarCheckActive) return;
        s.issues = issues;
        s.lastText = text;
        try {
          this.view.dispatch({ annotations: grammarRedecorate.of(true) });
        } catch (_) { /* view destroyed */ }
      }

      buildDecorations() {
        if (!stateRef.grammarCheckActive) return Decoration.none;
        const s = _viewState.get(this.view);
        if (!s || !s.issues.length) return Decoration.none;
        const docLen = this.view.state.doc.length;
        const builder = new RangeSetBuilder();
        const sorted = [...s.issues].sort((a, b) => a.from - b.from);
        for (const issue of sorted) {
          if (issue.from < 0 || issue.to > docLen || issue.from >= issue.to) continue;
          builder.add(
            issue.from,
            issue.to,
            Decoration.mark({
              class: "hush-grammar-error",
              attributes: {
                "data-grammar-message": issue.message || "",
                "data-grammar-suggestions": (issue.suggestions || []).join(" | "),
              },
            }),
          );
        }
        return builder.finish();
      }
    },
    { decorations: (v) => v.decorations },
  );
}

/** Hover tooltip showing the grammar message + suggestions. CodeMirror's
 *  `hoverTooltip` walks the hovered position; we map it back to the
 *  cached issue list and render a small tooltip if one matches. */
export function createGrammarHoverTooltip(stateRef) {
  return hoverTooltip((view, pos) => {
    if (!stateRef.grammarCheckActive) return null;
    const s = _viewState.get(view);
    if (!s || !s.issues.length) return null;
    const issue = s.issues.find((i) => pos >= i.from && pos <= i.to);
    if (!issue) return null;
    return {
      pos: issue.from,
      end: issue.to,
      above: true,
      create() {
        const dom = document.createElement("div");
        dom.className = "hush-grammar-tooltip";
        const msg = document.createElement("div");
        msg.className = "hush-grammar-tooltip-message";
        msg.textContent = issue.message || "Grammar issue";
        dom.appendChild(msg);
        if (issue.suggestions && issue.suggestions.length) {
          const sug = document.createElement("div");
          sug.className = "hush-grammar-tooltip-suggestions";
          sug.textContent = "Suggestions: " + issue.suggestions.slice(0, 5).join(", ");
          dom.appendChild(sug);
        }
        return { dom };
      },
    };
  }, { hoverTime: 250 });
}

/** Command-palette action — flip the active flag and ask the editor to
 *  redecorate. The first toggle-on schedules an immediate check; further
 *  edits flow through the plugin's debounce. */
export function toggleGrammarCheck(state) {
  if (state.currentNotebookFileId) return;
  state.grammarCheckActive = !state.grammarCheckActive;
  if (state.editor) {
    try {
      state.editor.view.dispatch({ annotations: grammarRedecorate.of(true) });
    } catch (_) { /* view not mounted */ }
  }
}
