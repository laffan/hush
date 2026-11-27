/**
 * The Overview Doc's section links — what makes the Doc down the
 * Project Overview's left side more than a pane.
 *
 * Select any text in it and the project's sections (its documents and
 * placeholders, in reading order — board-model.js#sectionList) drop
 * down from the selection (section-picker.js). Pick one and the words
 * become a link to it: `[the words](hush-section://<target>)` in the
 * text (editor/plugins/section-link-syntax.js), drawn here as the words
 * alone, subtly underlined — the brackets and the address are hidden
 * and the caret steps over them. A click on a link scrolls the board to
 * its section; ⌘-click takes the link away and leaves the words. Both
 * are edits to the text, so ⌘Z brings either back.
 *
 * The extension rides the pane's own editor (createPane's
 * `editorExtensions`), on top of everything a Doc pane has; it claims
 * section links from the ordinary link renderer (`sectionLinksOwned`).
 * `refreshSectionLinks` redraws the links after the board's sections
 * change (a document renamed, a placeholder removed).
 */
import { EditorView, ViewPlugin, Decoration, keymap } from "@codemirror/view";
import { StateField, StateEffect, Prec, EditorSelection } from "@codemirror/state";
import { highlightingFor } from "@codemirror/language";
import { tags } from "@lezer/highlight";
import {
  parseSectionLinks, sectionLinksOwned, sectionUrl,
} from "../editor/plugins/section-link-syntax.js";
import { hasModifier } from "../editor/plugins/link-decorator.js";
import { createSectionPicker } from "./section-picker.js";

export const refreshSectionLinks = StateEffect.define();

const hidden = Decoration.replace({});

/** A line's block markup — heading hashes, list bullets and checkboxes,
 *  numbers, quote marks — stays outside a link made on that line. */
function blockPrefixLength(text) {
  const m = /^(\s*(?:>\s*)*(?:#{1,6}\s+|[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)?)/.exec(text);
  return m ? m[1].length : 0;
}

/** A piece of text with its section links taken back to their words. */
function unwrapped(text) {
  let out = "";
  let at = 0;
  for (const l of parseSectionLinks(text)) {
    out += text.slice(at, l.from) + l.text;
    at = l.to;
  }
  return out + text.slice(at);
}

/** The edit that links `range` to `target`, or null when nothing in it
 *  can be linked (only spaces, or brackets of other markup inside). A
 *  link the range touches is taken in whole and re-made, so picking a
 *  section for words already linked moves the link; each line of the
 *  range is linked on its own, its block markup and the spaces at its
 *  ends left outside. */
export function planSectionLink(state, range, target, links = parseSectionLinks(state.doc.toString())) {
  const doc = state.doc;
  let from = range.from, to = range.to;
  for (const l of links) {
    if (l.from < to && l.to > from) { from = Math.min(from, l.from); to = Math.max(to, l.to); }
  }
  const changes = [];
  for (const l of links) {
    if (l.from >= from && l.to <= to) changes.push({ from: l.from, to: l.textFrom }, { from: l.textTo, to: l.to });
  }
  const close = `](${sectionUrl(target)})`;
  let wrapped = 0;
  for (let pos = from; pos <= to;) {
    const line = doc.lineAt(pos);
    let a = Math.max(from, line.from + blockPrefixLength(line.text));
    let b = Math.min(to, line.to);
    if (b > a) {
      const text = doc.sliceString(a, b);
      a += text.length - text.trimStart().length;
      b -= text.length - text.trimEnd().length;
      if (b > a && !/[[\]]/.test(unwrapped(doc.sliceString(a, b)))) {
        changes.push({ from: a, insert: "[" }, { from: b, insert: close });
        wrapped++;
      }
    }
    if (line.to >= to) break;
    pos = line.to + 1;
  }
  if (!wrapped) return null;
  changes.sort((x, y) => x.from - y.from);
  return { changes, from, to };
}

/** The section link holding `range` entirely, if one does. */
function linkHolding(links, range) {
  return links.find((l) => range.from >= l.textFrom && range.to <= l.textTo) || null;
}

/**
 * @param {object} cfg
 * @param {(target: string) => ({ name: string } | null)} cfg.resolve
 *   what a link's target is on the board now, null when it is gone
 * @param {() => Array} cfg.sections  the picker's list (sectionList)
 * @param {(target: string) => void} cfg.onFollow  a link was clicked
 */
export function sectionLinks(cfg) {
  const field = StateField.define({
    create: (state) => compute(state),
    update(value, tr) {
      if (tr.docChanged || tr.effects.some((e) => e.is(refreshSectionLinks))) return compute(tr.state);
      return value;
    },
    // The underline wraps everything else drawn on the words (outer
    // decorations), so styles.css can take the Markdown link's own
    // underline off the spans inside it.
    provide: (f) => [
      EditorView.decorations.from(f, (v) => v.hidden),
      EditorView.outerDecorations.from(f, (v) => v.marks),
      EditorView.atomicRanges.of((view) => view.state.field(f).hidden),
    ],
  });

  function compute(state) {
    const links = parseSectionLinks(state.doc.toString());
    const hides = [];
    const marks = [];
    for (const l of links) {
      const to = cfg.resolve(l.target);
      hides.push(hidden.range(l.from, l.textFrom), hidden.range(l.textTo, l.to));
      marks.push(Decoration.mark({
        class: "po-section-link" + (to ? "" : " broken"),
        attributes: {
          "data-section": l.target,
          title: to
            ? `${to.name} — click to go to it, ⌘-click to unlink`
            : "This section is no longer in the project — ⌘-click to unlink",
        },
      }).range(l.textFrom, l.textTo));
    }
    return { links, hidden: Decoration.set(hides, true), marks: Decoration.set(marks, true) };
  }

  const linkAt = (view, x, y) => {
    const pos = view.posAtCoords({ x, y });
    if (pos == null) return null;
    return view.state.field(field).links.find((l) => pos >= l.textFrom && pos <= l.textTo) || null;
  };

  function unlink(view, l) {
    view.dispatch({
      changes: [{ from: l.from, to: l.textFrom }, { from: l.textTo, to: l.to }],
      userEvent: "delete.unlink",
    });
  }

  function link(view, target) {
    const { state } = view;
    const range = state.selection.main;
    const plan = planSectionLink(state, range, target, state.field(field).links);
    if (!plan) return false;
    const changes = state.changes(plan.changes);
    // The caret goes to the end of what was linked, so the underline
    // shows instead of the selection.
    view.dispatch({
      changes,
      selection: EditorSelection.cursor(changes.mapPos(plan.to, 1)),
      userEvent: "input.link",
    });
    view.focus();
    return true;
  }

  /** The words of a link keep the colour they would have without it —
   *  but in a heading the Markdown link's colour and the heading's sit on
   *  one span, and the link's wins. The heading colour is a literal in
   *  the style's highlighting, so it is read off a probe (again whenever
   *  the editor is restyled) and handed to the stylesheet as
   *  `--po-heading-color`. */
  const headingColor = ViewPlugin.fromClass(class {
    constructor(view) { this.measure(view); }
    update(u) { if (u.transactions.some((tr) => tr.reconfigured)) this.measure(u.view); }
    measure(view) {
      view.requestMeasure({
        read: () => {
          const cls = highlightingFor(view.state, [tags.heading1]);
          if (!cls) return null;
          const probe = document.createElement("span");
          probe.className = cls;
          probe.style.cssText = "position:absolute;visibility:hidden;pointer-events:none";
          probe.textContent = "x";
          view.dom.appendChild(probe);
          const color = getComputedStyle(probe).color;
          probe.remove();
          return color;
        },
        write: (color) => {
          if (color) view.dom.style.setProperty("--po-heading-color", color);
          else view.dom.style.removeProperty("--po-heading-color");
        },
      });
    }
  });

  const picker = ViewPlugin.fromClass(class {
    constructor(view) {
      this.view = view;
      this.ui = createSectionPicker({
        view,
        sections: cfg.sections,
        onPick: (target) => link(view, target),
      });
      this.pressing = false;
      this.timer = 0;
      this.onDown = (e) => { if (e.button === 0) { this.pressing = true; this.ui.hide(); this.ui.forget(); } };
      this.onUp = () => { if (this.pressing) { this.pressing = false; this.schedule(40); } };
      view.contentDOM.addEventListener("pointerdown", this.onDown);
      window.addEventListener("pointerup", this.onUp, true);
    }
    update(u) {
      if (u.docChanged) this.ui.hide();
      if (u.transactions.some((tr) => tr.effects.some((e) => e.is(refreshSectionLinks)))) this.ui.refresh();
      if (u.selectionSet || u.focusChanged || u.docChanged) this.schedule();
    }
    /** Keyboard selections settle before the list comes up, so it
     *  doesn't flicker along a Shift-arrow sweep. */
    schedule(ms = 220) {
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.evaluate(), ms);
    }
    evaluate() {
      if (this.pressing) return;
      const { view } = this;
      const range = view.state.selection.main;
      const links = view.state.field(field).links;
      if (range.empty) this.ui.forget();
      if (range.empty || !view.hasFocus || !planSectionLink(view.state, range, "x", links)) { this.ui.hide(); return; }
      this.ui.show(range, linkHolding(links, range)?.target || null);
    }
    destroy() {
      clearTimeout(this.timer);
      this.view.contentDOM.removeEventListener("pointerdown", this.onDown);
      window.removeEventListener("pointerup", this.onUp, true);
      this.ui.destroy();
    }
  });

  const pickerOf = (view) => view.plugin(picker)?.ui;
  const keys = Prec.highest(keymap.of([
    { key: "ArrowDown", run: (v) => !!pickerOf(v)?.move(1) },
    { key: "ArrowUp", run: (v) => !!pickerOf(v)?.move(-1) },
    { key: "Enter", run: (v) => !!pickerOf(v)?.choose() },
    { key: "Escape", run: (v) => !!pickerOf(v)?.dismiss() },
  ]));

  const clicks = Prec.highest(EditorView.domEventHandlers({
    mousedown(e, view) {
      if (e.button !== 0 || !hasModifier(e)) return false;
      if (!e.target.closest?.(".po-section-link")) return false;
      const l = linkAt(view, e.clientX, e.clientY);
      if (!l) return false;
      e.preventDefault();
      unlink(view, l);
      return true;
    },
    click(e, view) {
      if (e.button !== 0 || hasModifier(e)) return false;
      const el = e.target.closest?.(".po-section-link");
      // A drag that selected words ends in a click too; only a plain
      // click (a caret) follows the link.
      if (!el || !view.state.selection.main.empty) return false;
      cfg.onFollow(el.dataset.section);
      return false;
    },
  }));

  return [sectionLinksOwned.of(true), field, headingColor, picker, keys, clicks];
}
