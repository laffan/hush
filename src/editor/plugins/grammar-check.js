/**
 * Grammar side of the combined Spelling/Grammar mode.
 *
 * Calls the `check_grammar` Tauri command (`harper-core` Rust crate) on
 * a 1.5s debounce after edits. Results are cached per `EditorView` in a
 * `WeakMap` so the buffer only re-lints after actual changes. A
 * companion `hoverTooltip` reuses the same cache to surface the harper
 * message + suggestions on hover.
 *
 * While harper is running — the first run can take a couple of seconds
 * because the curated dictionary is built lazily — a "Checking grammar…"
 * pill appears beside the word count slot via `setGrammarLoadingPill`.
 *
 * Doc-only — the toggle short-circuits when a notebook is open.
 */
import { ViewPlugin, Decoration, hoverTooltip } from "@codemirror/view";
import { RangeSetBuilder, Annotation } from "@codemirror/state";

export const grammarRedecorate = Annotation.define();

const DEBOUNCE_MS = 1500;
const IS_TAURI = typeof window !== "undefined" && window.__TAURI_INTERNALS__;

const _viewState = new WeakMap();
let _activeRunCount = 0;

/** Show / hide the "Checking grammar…" pill. Mounted into
 *  `#editor-container` once on first call so it inherits the editor's
 *  centring and font, and toggled via the `.visible` class. */
export function setGrammarLoadingPill(visible) {
  let pill = document.getElementById("hush-grammar-loading-pill");
  if (!pill) {
    if (!visible) return;
    const container = document.getElementById("editor-container");
    if (!container) return;
    pill = document.createElement("div");
    pill.id = "hush-grammar-loading-pill";
    pill.className = "hush-grammar-loading-pill";
    pill.textContent = "Checking grammar…";
    container.appendChild(pill);
  }
  pill.classList.toggle("visible", visible);
}

async function runGrammarCheck(text, disabledRules) {
  if (!IS_TAURI) return [];
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const result = await invoke("check_grammar", {
      text,
      disabledRules: disabledRules || [],
    });
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
        this._wasActive = !!stateRef.proofreadMode;
        this._timer = null;
        _viewState.set(view, { issues: [], lastText: null, runId: 0 });
        this.decorations = Decoration.none;
        if (stateRef.proofreadMode) this.scheduleCheck();
      }

      destroy() {
        if (this._timer) clearTimeout(this._timer);
        _viewState.delete(this.view);
      }

      update(update) {
        const active = !!stateRef.proofreadMode;
        const flipped = active !== this._wasActive;
        this._wasActive = active;

        const annot = update.transactions.some(
          (tr) => tr.annotation(grammarRedecorate),
        );

        if (!active && flipped) {
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
        if (!stateRef.proofreadMode) return;
        const s = _viewState.get(this.view);
        if (!s) return;
        const text = this.view.state.doc.toString();
        if (text === s.lastText) return;
        const myRun = ++s.runId;
        const disabledRules = stateRef.settings?.proofreadDisabledRules || [];
        _activeRunCount++;
        if (_activeRunCount === 1) setGrammarLoadingPill(true);
        try {
          const issues = await runGrammarCheck(text, disabledRules);
          if (myRun !== s.runId) return;
          if (!stateRef.proofreadMode) return;
          s.issues = issues;
          s.lastText = text;
          try {
            this.view.dispatch({ annotations: grammarRedecorate.of(true) });
          } catch (_) { /* view destroyed */ }
        } finally {
          _activeRunCount = Math.max(0, _activeRunCount - 1);
          if (_activeRunCount === 0) setGrammarLoadingPill(false);
        }
      }

      buildDecorations() {
        if (!stateRef.proofreadMode) return Decoration.none;
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

/** Hover tooltip showing the grammar message + suggestions. */
export function createGrammarHoverTooltip(stateRef) {
  return hoverTooltip((view, pos) => {
    if (!stateRef.proofreadMode) return null;
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
