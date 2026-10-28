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
 */
import { ViewPlugin } from "@codemirror/view";

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
        return {
          c,
          content: view.contentDOM.getBoundingClientRect(),
          lh: view.defaultLineHeight,
        };
      },
      write: (m) => this.paint(m),
    });
  }

  paint({ c, content, lh }) {
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
  return ViewPlugin.fromClass(CampfireView);
}
