/**
 * Campfire Cursor, in the editor — every doc surface (main editor, Zen,
 * Selection Focus, panes, stack columns) carries this plugin; it does
 * nothing until the campfire is lit (campfire/campfire.js calls
 * `setCampfire`).
 *
 * Lit, a surface's text is masked (styles/campfire.css): everywhere it
 * shows at the base opacity, and round the caret a soft oval of light
 * shows it fully — or, with Current line only, the part of that oval on
 * the caret's line. Only the characters are lit: the mask is on the
 * text, so the page behind it is untouched. The plugin keeps the spot
 * under the caret by writing the caret's place in the text as CSS
 * properties on the content element.
 *
 * There is one fire: at the caret of the doc last written in (`--cf-vis`
 * 1); every other surface stays dark (0). It burns steadily — it doesn't
 * blink or pulse with the caret — and stays where it was left while
 * focus is elsewhere (a modal, the sidebar).
 *
 * The per-surface properties are registered as not inherited, so
 * changing them restyles the content element alone, not every line in it.
 *
 * **Glow matches cursor colour** tints only the lit words: each word in
 * the light gets a mark mixing the caret's colour into its own, by how
 * near the light's middle it sits (the mask's own falloff, read from
 * the words' places on screen in the measure pass). Every other word
 * keeps its colour.
 */
import { ViewPlugin, Decoration, EditorView } from "@codemirror/view";
import { StateEffect, StateField } from "@codemirror/state";

/** @type {Set<CampfireView>} */
const views = new Set();
let lit = false;
let opts = null;
let active = null;

try {
  for (const name of ["--cf-x", "--cf-y", "--cf-lh", "--cf-vis", "--cf-band-top", "--cf-band-bottom"]) {
    CSS.registerProperty({ name, syntax: "*", inherits: false });
  }
} catch { /* registered already, or unsupported: they inherit, which only costs time */ }

// The lit words' tint: `[{ from, to, w }]` in, mark decorations out,
// mapped through edits until the next measure replaces them.
const setTint = StateEffect.define();
const tintMarks = new Map();
function tintMark(w) {
  let m = tintMarks.get(w);
  if (!m) {
    m = Decoration.mark({ attributes: { style: `color: color-mix(in srgb, var(--block-cursor-color, var(--cursor)) ${Math.round(w * 100)}%, currentColor)` } });
    tintMarks.set(w, m);
  }
  return m;
}
const tintField = StateField.define({
  create: () => Decoration.none,
  update(deco, tr) {
    for (const e of tr.effects) {
      if (e.is(setTint)) return Decoration.set(e.value.map((t) => tintMark(t.w).range(t.from, t.to)), true);
    }
    return tr.docChanged ? deco.map(tr.changes) : deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

/** How lit a point is, 0..1, at normalised distance `d` from the light's
 *  middle (1 = its rim) — the mask's gradient: full to the plateau,
 *  0.45 at the mid stop, out at the rim. */
function lightAt(d) {
  const plateau = Math.max(0, Math.min(0.6, (opts.brightness - 1) * 0.5));
  const mid = plateau + (1 - plateau) * 0.45;
  const peak = Math.min(1, opts.brightness);
  if (d <= plateau) return peak;
  if (d >= 1) return 0;
  if (d <= mid) return peak * (1 - 0.55 * (d - plateau) / Math.max(mid - plateau, 1e-3));
  return peak * 0.45 * (1 - (d - mid) / Math.max(1 - mid, 1e-3));
}

class CampfireView {
  constructor(view) {
    this.view = view;
    views.add(this);
    if (lit) this.measure();
  }

  update(u) {
    if (!lit) return;
    if (u.focusChanged && u.view.hasFocus) setActive(this);
    if (u.selectionSet || u.docChanged || u.geometryChanged || u.viewportChanged || u.focusChanged) this.measure();
  }

  /** A surface inside a card is part of what the doc around it shows;
   *  only the doc's own text is masked. */
  get eligible() {
    return !this.view.dom.closest(".hush-card");
  }

  measure() {
    const view = this.view;
    view.requestMeasure({
      key: this,
      read: () => {
        const head = view.state.selection.main.head;
        const c = view.coordsAtPos(head, 1) || view.coordsAtPos(head, -1);
        const lh = view.defaultLineHeight;
        return {
          c,
          content: view.contentDOM.getBoundingClientRect(),
          lh,
          tint: this.readTint(head, c, lh),
        };
      },
      write: (m) => this.paint(m),
    });
  }

  /** The words in the light and how lit each is, when the tint is on
   *  and this is the fire's surface. Only words on lines the light can
   *  reach are looked at (on the caret's line alone with Current line
   *  only). */
  readTint(head, c, lh) {
    if (!lit || !opts?.matchCursor || this !== active || !c || !this.eligible) return [];
    const view = this.view;
    const ry = opts.range * lh;
    const rx = ry * 1.4;
    const cx = c.left;
    const cy = (c.top + c.bottom) / 2;
    const reach = opts.currentLine ? 0 : ry;
    const out = [];
    const { from: vFrom, to: vTo } = view.viewport;
    const a = Math.max(vFrom, head - 2000);
    const b = Math.min(vTo, head + 2000);
    const text = view.state.sliceDoc(a, b);
    for (const m of text.matchAll(/\S+/g)) {
      const from = a + m.index;
      const to = from + m[0].length;
      const p = view.coordsAtPos(from, 1);
      if (!p) continue;
      const y = (p.top + p.bottom) / 2;
      if (opts.currentLine ? (y < c.top || y > c.bottom) : Math.abs(y - cy) > reach) continue;
      const q = view.coordsAtPos(to, -1);
      const x = q && Math.abs(q.top - p.top) < 2 ? (p.left + q.right) / 2 : p.left;
      const w = Math.round(lightAt(Math.hypot((x - cx) / rx, (y - cy) / ry)) * 10) / 10;
      if (w > 0) out.push({ from, to, w });
    }
    return out;
  }

  /** Hand the tint to the field — after the measure, since a measure
   *  can't dispatch — when it changed. */
  writeTint(tint) {
    const key = tint.map((t) => `${t.from}:${t.to}:${t.w}`).join(",");
    if (key === this.tintKey) return;
    this.tintKey = key;
    const view = this.view;
    queueMicrotask(() => { if (views.has(this)) view.dispatch({ effects: setTint.of(tint) }); });
  }

  paint({ c, content, lh, tint }) {
    this.writeTint(tint || []);
    const dom = this.view.dom;
    const on = lit && this.eligible;
    dom.classList.toggle("cf-surface", on);
    const s = this.view.contentDOM.style;
    if (!on || !c) {
      for (const p of ["--cf-x", "--cf-y", "--cf-band-top", "--cf-band-bottom"]) s.removeProperty(p);
      return;
    }
    const x = c.left - content.left;
    const top = c.top - content.top;
    const bottom = c.bottom - content.top;
    s.setProperty("--cf-x", `${x}px`);
    s.setProperty("--cf-y", `${(top + bottom) / 2}px`);
    s.setProperty("--cf-lh", `${lh}px`);
    if (opts.currentLine) {
      s.setProperty("--cf-band-top", `${top}px`);
      s.setProperty("--cf-band-bottom", `${bottom}px`);
    } else {
      s.removeProperty("--cf-band-top");
      s.removeProperty("--cf-band-bottom");
    }
    this.writeVis();
  }

  writeVis() {
    this.view.contentDOM.style.setProperty("--cf-vis", this === active ? "1" : "0");
  }

  clear() {
    this.writeTint([]);
    this.view.dom.classList.remove("cf-surface");
    const s = this.view.contentDOM.style;
    for (const p of ["--cf-x", "--cf-y", "--cf-lh", "--cf-vis", "--cf-band-top", "--cf-band-bottom"]) s.removeProperty(p);
  }

  destroy() {
    this.clear();
    views.delete(this);
    if (active === this) active = null;
  }
}

function setActive(p) {
  if (active === p) return;
  const prev = active;
  active = p;
  prev?.writeVis();
  p.writeVis();
  prev?.measure(); // its tint goes
}

/** Light (`options`) or put out (null) the campfire on every surface. */
export function setCampfire(options) {
  lit = !!options;
  opts = options;
  if (!lit) {
    for (const p of views) p.clear();
    active = null;
    return;
  }
  if (!active || !views.has(active)) {
    const list = [...views].filter((p) => p.eligible && p.view.dom.isConnected);
    active = list.find((p) => p.view.hasFocus)
      || list.find((p) => p.view.dom.closest("#editor-container"))
      || list[0] || null;
  }
  for (const p of views) p.measure();
}

export function createCampfirePlugin() {
  return [tintField, ViewPlugin.fromClass(CampfireView)];
}
