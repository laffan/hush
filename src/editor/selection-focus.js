/**
 * Selection Focus — a focused-reading-and-editing overlay fired by the
 * Focus shortcut when an active editor selection is non-empty.
 *
 * Sits between regular Focus mode (dim the rest of the doc, keep the
 * editor surface where it is) and Zen Focus (fullscreen, bigger font,
 * whole-doc shadow editor): like Zen, the overlay paints over every
 * other piece of chrome, mounts a fresh CodeMirror seeded with the
 * captured text, and supports the user's full editing surface (all
 * cursor types, all base-extension plugins). Unlike Zen, the editor
 * only carries the selected range (not the whole doc), so the user's
 * eye lands on exactly that block; type defaults to the source's own
 * size bumped 20 % (with a Zen-style font slider for live tuning),
 * and the column width tracks the source view's width so the line
 * measure the user dialled in is preserved.
 *
 * On exit, the (possibly edited) content writes back over the
 * original selection range in the source view as a single transaction
 * — so undo history stays sensible.
 */

import { EditorView } from "@codemirror/view";
import { EditorState, EditorSelection } from "@codemirror/state";
import { createBaseExtensions } from "./base-extensions.js";
import { applyBlockCursor } from "./block-cursor.js";

let active = null;

/** Default font-size multiplier — the source view's computed font-size
 *  is scaled by this on first entry. Stored as a setting so the user's
 *  slider tweak rides across the entire library rather than locking to
 *  a single style's pixel value. */
const DEFAULT_FONT_SIZE_MULTIPLIER = 1.2;

export function initSelectionFocus(state) {
  state.on("selection-focus-changed", () => {
    if (state.selectionFocus) enterSelectionFocus(state);
    else exitSelectionFocus(state);
  });
}

/** Resolve the active font size in px. Honour the user's saved
 *  multiplier from settings; fall back to the default if nothing's
 *  saved. The source's px size is captured at entry time so a style
 *  change while the overlay is open doesn't pull the rug out. */
function resolveFontSize(state, basePx) {
  const m = Number(state.settings?.selectionFocusFontMultiplier);
  const mult = Number.isFinite(m) && m > 0 ? m : DEFAULT_FONT_SIZE_MULTIPLIER;
  return basePx * mult;
}

function enterSelectionFocus(state) {
  if (active) return;
  const payload = state._selectionFocusPayload;
  if (!payload || !payload.text || !payload.sourceView) {
    // Nothing to focus on — back the flag out so the next shortcut
    // press starts fresh.
    state.selectionFocus = false;
    return;
  }

  const overlay = document.createElement("div");
  overlay.className = "selection-focus-overlay";

  const stage = document.createElement("div");
  stage.className = "selection-focus-stage";
  // Match the source view's column width so the line measure the user
  // dialled in carries over to the focused view.
  if (payload.columnWidth) stage.style.width = `${payload.columnWidth}px`;
  overlay.appendChild(stage);

  // Bumped font size — the source's own size scaled by the saved
  // multiplier (defaults to 1.2x). The font slider mounts next to
  // the overlay and writes back to the multiplier live.
  const basePx = payload.fontSizePx || 16;
  function applyFontSize() {
    overlay.style.setProperty(
      "--selection-focus-font-size",
      `${resolveFontSize(state, basePx)}px`,
    );
  }
  applyFontSize();

  document.body.classList.add("selection-focus-active");
  document.body.appendChild(overlay);
  applyBlockCursor(state);

  // Build a fresh CodeMirror seeded with the captured selection. The
  // base extensions cover markdown, callouts, links, formatting, image
  // refs, etc., so the focused editor behaves identically to a pane
  // editor on the same content. The selection starts at the head end
  // of the captured range so the cursor lands at the end of the block.
  // `fragment`: this editor holds the selected range, not the document,
  // so a ratchet mustn't treat its first line as the doc's filename.
  const { extensions } = createBaseExtensions(state, () => { /* no per-keystroke sync */ }, { fragment: true });
  const len = payload.text.length;
  const editorState = EditorState.create({
    doc: payload.text,
    selection: EditorSelection.range(len, len),
    extensions,
  });
  const view = new EditorView({ state: editorState, parent: stage });

  // Mirror the active style's text-colour override so the focused
  // editor matches the surrounding chrome — see the matching note in
  // zen-focus.js for the same trick.
  const styleFg = getComputedStyle(document.documentElement)
    .getPropertyValue("--style-fg").trim();
  if (styleFg) view.dom.style.color = styleFg;

  const onKeydown = (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      state.toggleSelectionFocus();
    }
  };
  document.addEventListener("keydown", onKeydown, true);

  // Font-size pill — same visual language as Zen's cmd-held sliders,
  // but only the Font control (no Dim, no Window). Mounts as a child
  // of the overlay so it tears down automatically on exit, and lives
  // outside the stage so it stays out of the centred text block.
  const fontPill = mountFontPill(overlay, state, basePx, () => applyFontSize());

  const onSettingsChanged = () => {
    applyFontSize();
    fontPill.refresh();
  };
  state.on("settings-changed", onSettingsChanged);

  view.focus();

  active = {
    overlay,
    view,
    onKeydown,
    onSettingsChanged,
    sourceView: payload.sourceView,
    from: payload.from,
    to: payload.to,
  };
}

function exitSelectionFocus(state) {
  if (!active) return;
  const a = active;
  active = null;

  // Snapshot the (possibly edited) content + selection before tearing
  // down the focused editor.
  const finalContent = a.view.state.doc.toString();
  const finalSel = a.view.state.selection.main;

  document.removeEventListener("keydown", a.onKeydown, true);
  if (a.onSettingsChanged) state.off("settings-changed", a.onSettingsChanged);
  a.view.destroy();
  a.overlay.remove();
  document.body.classList.remove("selection-focus-active");
  state._selectionFocusPayload = null;

  // Write the edited block back over the original selection range as
  // a single transaction so undo collapses Selection-Focus edits to
  // one step from the source view's perspective. If the source view
  // was destroyed while we were focused (rare — closing a pane that
  // hosted the source), the dispatch throws and we just bail.
  try {
    const src = a.sourceView;
    if (!src || !src.state) return;
    const docLen = src.state.doc.length;
    const from = Math.max(0, Math.min(a.from, docLen));
    const to   = Math.max(from, Math.min(a.to, docLen));
    const newTo = from + finalContent.length;
    const cursorAnchor = from + Math.min(finalSel.anchor, finalContent.length);
    const cursorHead   = from + Math.min(finalSel.head,   finalContent.length);
    src.dispatch({
      changes: { from, to, insert: finalContent },
      selection: EditorSelection.range(cursorAnchor, cursorHead),
    });
    // Move the source's viewport so the (now-edited) block lands back
    // in view — without this the user's eye lands wherever the source
    // had scrolled to before the overlay opened.
    src.dispatch({ effects: EditorView.scrollIntoView(newTo, { y: "center" }) });
    src.focus();
  } catch (_) { /* source went away mid-focus */ }
}

/** Mount a cmd-held-styled Font pill into the overlay. The slider
 *  adjusts the saved multiplier so the size scales relative to the
 *  source's own font-size — switching between styles after a tweak
 *  keeps the relative size the user dialled in. Returns a `refresh`
 *  hook the entry path uses to re-seed the slider when settings
 *  change underneath the overlay. */
function mountFontPill(overlay, state, basePx, onUpdate) {
  const wrap = document.createElement("div");
  wrap.className = "cmd-held-sliders-wrap selection-focus-sliders";

  const caret = document.createElement("div");
  caret.className = "cmd-held-sliders-caret";
  caret.setAttribute("aria-hidden", "true");
  caret.innerHTML = `<svg viewBox="0 0 16 10" width="16" height="10" aria-hidden="true">
    <path d="M2 9 L8 1.5 L14 9" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" fill="none" />
  </svg>`;
  wrap.appendChild(caret);

  const pill = document.createElement("div");
  pill.className = "cmd-held-sliders";

  const group = document.createElement("div");
  group.className = "cmd-held-slider-group";

  const label = document.createElement("span");
  label.className = "cmd-held-slider-label";
  label.textContent = "Font";

  // Slider range expressed as a percentage of the source's own size
  // (50 % – 250 %). The readout shows the resolved px so the user
  // can match a specific style's typography by eye.
  const input = document.createElement("input");
  input.type = "range";
  input.min = "50";
  input.max = "250";
  input.step = "1";
  function currentMultiplier() {
    const m = Number(state.settings?.selectionFocusFontMultiplier);
    return Number.isFinite(m) && m > 0 ? m : DEFAULT_FONT_SIZE_MULTIPLIER;
  }
  input.value = String(Math.round(currentMultiplier() * 100));

  const readout = document.createElement("span");
  readout.className = "cmd-held-slider-readout";
  function updateReadout(pct) {
    readout.textContent = `${Math.round((pct / 100) * basePx)}px`;
  }
  updateReadout(parseFloat(input.value));

  input.addEventListener("input", () => {
    const pct = parseFloat(input.value);
    updateReadout(pct);
    state.updateSettings({ selectionFocusFontMultiplier: pct / 100 });
    onUpdate();
  });

  group.addEventListener("pointerdown", (e) => e.stopPropagation());

  group.appendChild(label);
  group.appendChild(input);
  group.appendChild(readout);
  pill.appendChild(group);
  wrap.appendChild(pill);
  overlay.appendChild(wrap);

  return {
    refresh() {
      if (document.activeElement === input) return; // mid-drag — leave alone
      const pct = Math.round(currentMultiplier() * 100);
      input.value = String(pct);
      updateReadout(pct);
    },
  };
}
