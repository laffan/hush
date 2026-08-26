/**
 * Spellcheck — fast click-to-fix spelling underlines.
 *
 * Different from Proofread (`grammar-check.js`) in three ways:
 *   - Backed by the `spellbook` crate (pure-Rust Hunspell) instead of
 *     harper-core. Load is ~10 ms, so we don't need a "warming up"
 *     modal — the underlines paint within a frame or two of the first
 *     toggle.
 *   - Persisted across sessions (`state.spellcheckMode`).
 *   - Underlines are clickable: a small popover opens with the
 *     dictionary's suggestions, click one to replace the word in place.
 *
 * Doc-only, like Proofread; notebooks pass through unchanged.
 */
import { ViewPlugin, Decoration, EditorView } from "@codemirror/view";
import { RangeSetBuilder, Annotation } from "@codemirror/state";

export const spellcheckRedecorate = Annotation.define();

const DEBOUNCE_MS = 600;
const IS_TAURI = typeof window !== "undefined" && window.__TAURI_INTERNALS__;

const _viewState = new WeakMap();

async function runSpellCheck(text) {
  if (!IS_TAURI) return [];
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const result = await invoke("check_spelling", { text });
    return Array.isArray(result) ? result : [];
  } catch (e) {
    console.warn("check_spelling failed:", e);
    return [];
  }
}

async function fetchSuggestions(word) {
  if (!IS_TAURI) return [];
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const result = await invoke("spelling_suggestions", { word });
    return Array.isArray(result) ? result : [];
  } catch (e) {
    console.warn("spelling_suggestions failed:", e);
    return [];
  }
}

export function createSpellcheckPlugin(stateRef) {
  return ViewPlugin.fromClass(
    class {
      constructor(view) {
        this.view = view;
        this._wasActive = !!stateRef.spellcheckMode;
        this._timer = null;
        _viewState.set(view, { issues: [], lastText: null, runId: 0 });
        this.decorations = Decoration.none;
        if (stateRef.spellcheckMode && view.hasFocus) this.runCheckNow();
      }

      destroy() {
        if (this._timer) clearTimeout(this._timer);
        _viewState.delete(this.view);
      }

      update(update) {
        const active = !!stateRef.spellcheckMode;
        const flipped = active !== this._wasActive;
        this._wasActive = active;

        const annot = update.transactions.some(
          (tr) => tr.annotation(spellcheckRedecorate),
        );

        if (!active && flipped) {
          if (this._timer) { clearTimeout(this._timer); this._timer = null; }
          const s = _viewState.get(this.view);
          if (s) { s.issues = []; s.lastText = null; }
          this.decorations = Decoration.none;
          closeSpellPopover();
          return;
        }

        // Typing moves every word after the caret, but the issue list is
        // whatever the last check returned — absolute offsets into the
        // document as it was. Map both the stored ranges and the live
        // decoration set through the change so the underlines travel
        // with their words instead of sitting at stale offsets until the
        // debounce fires. (CodeMirror maps nothing on a ViewPlugin's
        // behalf; without this the marks drifted backwards under the
        // text and snapped into place ~600 ms after the last keystroke.)
        // `from` maps with assoc 1 and `to` with -1, matching how a mark
        // decoration maps itself: text typed against either edge of a
        // word lands outside the underline rather than extending it.
        if (update.docChanged) {
          const s = _viewState.get(this.view);
          if (s && s.issues.length) {
            const mapped = [];
            for (const issue of s.issues) {
              const from = update.changes.mapPos(issue.from, 1);
              const to = update.changes.mapPos(issue.to, -1);
              if (from < to) mapped.push({ ...issue, from, to });
            }
            s.issues = mapped;
          }
          this.decorations = this.decorations.map(update.changes);
        }

        if (active && flipped) {
          if (this._timer) { clearTimeout(this._timer); this._timer = null; }
          if (this.view.hasFocus) this.runCheckNow();
        } else if (active && update.docChanged && this.view.hasFocus) {
          this.scheduleCheck();
        }

        // Spellcheck underlines belong to the editor that currently holds
        // focus — a stack of open panes shouldn't all paint at once. When
        // this editor gains focus, make sure its issues are fresh; when it
        // loses focus, the rebuild below drops its decorations.
        if (active && update.focusChanged) {
          if (this.view.hasFocus) this.runCheckNow();
          else if (!spellPopoverHoldsFocus() && !spellPopoverPressed()) closeSpellPopover();
        }

        if (annot || update.viewportChanged || flipped || update.focusChanged) {
          this.decorations = this.buildDecorations();
        }
      }

      scheduleCheck() {
        if (this._timer) clearTimeout(this._timer);
        this._timer = setTimeout(() => { this.runCheckNow(); }, DEBOUNCE_MS);
      }

      async runCheckNow() {
        if (!stateRef.spellcheckMode) return;
        const s = _viewState.get(this.view);
        if (!s) return;
        const text = this.view.state.doc.toString();
        if (text === s.lastText) return;
        const myRun = ++s.runId;
        const issues = await runSpellCheck(text);
        if (myRun !== s.runId) return;
        if (!stateRef.spellcheckMode) return;
        s.issues = issues;
        s.lastText = text;
        try {
          this.view.dispatch({ annotations: spellcheckRedecorate.of(true) });
        } catch (_) { /* view destroyed */ }
      }

      buildDecorations() {
        if (!stateRef.spellcheckMode) return Decoration.none;
        // Only the focused editor surface shows underlines.
        if (!this.view.hasFocus) return Decoration.none;
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
              class: "hush-spellcheck-error",
              attributes: { "data-spell-word": issue.word || "" },
            }),
          );
        }
        return builder.finish();
      }
    },
    { decorations: (v) => v.decorations },
  );
}

/* ------------------------------------------------------------------ */
/* Click-to-fix popover                                                */
/* ------------------------------------------------------------------ */

let _popoverEl = null;
let _popoverHostView = null;
let _popoverDocListener = null;
let _popoverKeyListener = null;
let _popoverPressedAt = 0;
let _swallowMouseUntil = 0;
/** How long a press keeps the popover alive against the blur it causes,
 *  and how long a committed suggestion waits for the compatibility
 *  `mousedown` that follows it. Sized for iPadOS's synthetic-mouse
 *  delay, which runs to a few hundred ms after `touchend`. */
const POPOVER_PRESS_MS = 900;

/** True while the open popover owns the focus. Blurring the editor
 *  normally means the user moved on and the popover should go, but the
 *  popover is a menu they have to reach *by* clicking, so a blur into it
 *  is the opposite of moving on. */
function spellPopoverHoldsFocus() {
  return !!(_popoverEl && _popoverEl.contains(document.activeElement));
}

/** True for a short window after the user pressed inside the popover.
 *  On iPadOS the blur that a tap causes and the tap's own handling do
 *  not arrive together — WebKit delivers the compatibility mouse events
 *  hundreds of ms after `touchend` — so a blur landing right after a
 *  press is *part of* that press, not the user moving on. Tearing the
 *  menu down there is what made picking a suggestion do nothing. */
function spellPopoverPressed() {
  return Date.now() - _popoverPressedAt < POPOVER_PRESS_MS;
}

function closeSpellPopover() {
  if (_popoverEl) {
    _popoverEl.remove();
    _popoverEl = null;
  }
  _popoverHostView = null;
  if (_popoverDocListener) {
    document.removeEventListener("pointerdown", _popoverDocListener, true);
    _popoverDocListener = null;
  }
  if (_popoverKeyListener) {
    document.removeEventListener("keydown", _popoverKeyListener, true);
    _popoverKeyListener = null;
  }
}

function applySpellReplacement(view, issue, replacement) {
  try {
    // The range was measured when the popover opened. Only write if the
    // document still reads the same there — a fetch of suggestions is a
    // round trip to the dictionary, and the user can type through it.
    // Better to do nothing than to overwrite whatever moved into the
    // span in the meantime.
    const len = view.state.doc.length;
    if (issue.from < 0 || issue.to > len || issue.from >= issue.to) return;
    if (view.state.doc.sliceString(issue.from, issue.to) !== issue.word) return;
    view.dispatch({
      changes: { from: issue.from, to: issue.to, insert: replacement },
      selection: { anchor: issue.from + replacement.length },
    });
  } catch (_) { /* view destroyed */ }
}

async function openSpellPopover(view, issue, anchorX, anchorY) {
  closeSpellPopover();
  const el = document.createElement("div");
  el.className = "hush-spellcheck-popover";
  el.setAttribute("role", "menu");

  const header = document.createElement("div");
  header.className = "hush-spellcheck-popover-header";
  header.textContent = issue.word;
  el.appendChild(header);

  const loading = document.createElement("div");
  loading.className = "hush-spellcheck-popover-loading";
  loading.textContent = "Loading…";
  el.appendChild(loading);

  // Initial paint at click point so the popover appears immediately;
  // it'll fill in once suggestions resolve. Clamp on the right so wide
  // suggestion lists never overflow the viewport.
  el.style.position = "fixed";
  el.style.left = `${anchorX}px`;
  el.style.top = `${anchorY}px`;
  el.style.visibility = "hidden";
  document.body.appendChild(el);
  _popoverEl = el;
  _popoverHostView = view;

  // Reposition once mounted so the bottom of the popover doesn't slide
  // off-screen below the cursor.
  requestAnimationFrame(() => {
    if (!_popoverEl) return;
    const rect = el.getBoundingClientRect();
    let left = anchorX;
    let top = anchorY;
    if (left + rect.width > window.innerWidth - 8) {
      left = Math.max(8, window.innerWidth - rect.width - 8);
    }
    if (top + rect.height > window.innerHeight - 8) {
      top = Math.max(8, anchorY - rect.height - 8);
    }
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
    el.style.visibility = "visible";
  });

  // Dismiss-on-outside listens for `pointerdown`, not `mousedown`: on
  // iPadOS the synthetic `mousedown` lands hundreds of ms after
  // `touchend`, well past the rAF that armed this — so a `mousedown`
  // dismiss self-closes on the very tap that opened the popover.
  _popoverDocListener = (ev) => {
    if (!_popoverEl) return;
    if (_popoverEl.contains(ev.target)) return;
    closeSpellPopover();
  };
  document.addEventListener("pointerdown", _popoverDocListener, true);

  _popoverKeyListener = (ev) => {
    if (ev.key === "Escape") { ev.stopPropagation(); closeSpellPopover(); }
  };
  document.addEventListener("keydown", _popoverKeyListener, true);

  const suggestions = await fetchSuggestions(issue.word);
  if (_popoverEl !== el) return; // closed while we were fetching

  loading.remove();

  if (!suggestions.length) {
    const empty = document.createElement("div");
    empty.className = "hush-spellcheck-popover-empty";
    empty.textContent = "No suggestions";
    el.appendChild(empty);
  } else {
    const list = document.createElement("div");
    list.className = "hush-spellcheck-popover-list";
    for (const sugg of suggestions) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "hush-spellcheck-popover-row";
      row.textContent = sugg;
      const commit = () => {
        _popoverPressedAt = Date.now();
        // The popover is about to leave the document, so the tap's
        // trailing `mousedown` will land on the editor underneath and
        // drag the caret off the word we just corrected. Claim it.
        _swallowMouseUntil = Date.now() + POPOVER_PRESS_MS;
        applySpellReplacement(view, issue, sugg);
        closeSpellPopover();
      };
      // Commit on *pointerdown* — the gesture's first event, and the
      // only one that arrives while the row is still in the document.
      // `mousedown` is not early enough: on iPadOS WebKit delivers the
      // compatibility mouse events hundreds of ms after `touchend`, and
      // the tap's blur closes the popover in between, so the row is gone
      // before `mousedown` (never mind `click`) is dispatched. That is
      // the whole bug — picking a suggestion did nothing on iPad, and
      // committing on `mousedown` only moved the failure one event
      // later. Cancelling the default keeps focus, and so the caret and
      // the underlines, in the editor.
      row.addEventListener("pointerdown", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        commit();
      });
      // Keyboard activation dispatches a click with no preceding
      // pointer event; `detail === 0` is how that arrives.
      row.addEventListener("click", (ev) => {
        if (ev.detail !== 0) return;
        ev.preventDefault();
        commit();
      });
      list.appendChild(row);
    }
    el.appendChild(list);
  }

  // Re-clamp now that the final height is known.
  requestAnimationFrame(() => {
    if (_popoverEl !== el) return;
    const rect = el.getBoundingClientRect();
    let top = parseFloat(el.style.top);
    if (top + rect.height > window.innerHeight - 8) {
      top = Math.max(8, window.innerHeight - rect.height - 8);
      el.style.top = `${top}px`;
    }
  });
}

/** The flagged issue under a pointer event, or null. */
function issueAtEvent(ev, view) {
  let el = ev.target;
  while (el && el !== view.dom) {
    if (el.classList && el.classList.contains("hush-spellcheck-error")) break;
    el = el.parentNode;
  }
  if (!el || el === view.dom) return null;
  const s = _viewState.get(view);
  if (!s || !s.issues.length) return null;
  const pos = view.posAtCoords({ x: ev.clientX, y: ev.clientY });
  if (pos == null) return null;
  return s.issues.find((i) => pos >= i.from && pos <= i.to) || null;
}

/** Opens the suggestion popover for a press on a `.hush-spellcheck-error`
 *  decoration. Installed via EditorView.domEventHandlers so we don't
 *  fight CodeMirror's own selection logic.
 *
 *  `pointerdown` is the gesture's first event, and the one that fires
 *  before a tap places the caret and re-renders the decoration out from
 *  under itself. The `mousedown` half opens nothing — it swallows the
 *  one compatibility event that follows a committed suggestion, which
 *  WebKit sends after the popover has already left the document (and
 *  sends for a mouse even though `pointerdown` was cancelled). Left
 *  alone it lands on the editor and drags the caret off the corrected
 *  word. */
export const spellcheckClickHandler = EditorView.domEventHandlers({
  pointerdown(ev, view) {
    const issue = issueAtEvent(ev, view);
    if (!issue) return false;
    _popoverPressedAt = Date.now();
    ev.preventDefault();
    ev.stopPropagation();
    openSpellPopover(view, issue, ev.clientX, ev.clientY);
    return true;
  },
  mousedown(ev) {
    if (Date.now() >= _swallowMouseUntil) return false;
    _swallowMouseUntil = 0; // one event only — the rest are the user's
    ev.preventDefault();
    ev.stopPropagation();
    return true;
  },
});
