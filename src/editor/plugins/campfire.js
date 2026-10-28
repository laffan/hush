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
 * There is one fire: at the caret of the doc last written in. Every
 * other surface stays dark. With "follows the cursor" on, the light goes
 * out and comes back with the caret — one loop reads the caret layer's
 * opacity as CodeMirror's blink (or Hush's pulse) animates it, eased a
 * little so a blink dims rather than snaps, and writes it back as
 * `--cf-vis`. While focus is elsewhere (a modal, the sidebar) the caret
 * isn't drawn; the fire then burns steadily where it was left.
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
let raf = 0;
let lastTick = 0;
const TICK_MS = 1000 / 30;

try {
  for (const name of ["--cf-x", "--cf-y", "--cf-lh", "--cf-vis", "--cf-band-top", "--cf-band-bottom"]) {
    CSS.registerProperty({ name, syntax: "*", inherits: false });
  }
} catch { /* registered already, or unsupported: they inherit, which only costs time */ }

class CampfireView {
  constructor(view) {
    this.view = view;
    this.vis = 1;
    views.add(this);
    if (lit) this.measure();
  }

  update(u) {
    if (!lit) return;
    if (u.focusChanged) {
      if (u.view.hasFocus) setActive(this);
      kick();
    }
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
    this.writeVis(this === active ? this.vis : 0, true);
  }

  writeVis(v, force = false) {
    const q = Math.round(v * 50) / 50;
    if (!force && q === this.written) return;
    this.written = q;
    this.view.contentDOM.style.setProperty("--cf-vis", String(q));
  }

  clear() {
    this.view.dom.classList.remove("cf-surface");
    const s = this.view.contentDOM.style;
    for (const p of ["--cf-x", "--cf-y", "--cf-lh", "--cf-vis", "--cf-band-top", "--cf-band-bottom"]) s.removeProperty(p);
    this.written = undefined;
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
  prev?.writeVis(0);
  p.vis = 1;
  p.writeVis(1);
  kick();
}

/** How visible the caret is right now: its layer's animated opacity —
 *  CodeMirror's blink, or the Pulse idle animation. */
function caretOpacity(view) {
  const layer = view.scrollDOM.querySelector(":scope > .cm-cursorLayer");
  if (!layer) return 1;
  const o = parseFloat(getComputedStyle(layer).opacity);
  return Number.isFinite(o) ? o : 1;
}

function tick(now) {
  raf = 0;
  if (!lit || !active || document.hidden) return;
  const following = opts.followCursor && active.view.hasFocus;
  if (now - lastTick >= TICK_MS) {
    lastTick = now;
    const target = following ? caretOpacity(active.view) : 1;
    active.vis += (target - active.vis) * 0.55;
    if (Math.abs(target - active.vis) < 0.01) active.vis = target;
    active.writeVis(active.vis);
  }
  // Steady (focus elsewhere, or not following) once the light is full.
  if (following || active.vis < 1) raf = requestAnimationFrame(tick);
}

function kick() {
  if (!raf && lit) raf = requestAnimationFrame(tick);
}

document.addEventListener("visibilitychange", () => { if (!document.hidden) kick(); });
document.addEventListener("focusin", () => kick());

/** Light (`options`) or put out (null) the campfire on every surface. */
export function setCampfire(options) {
  lit = !!options;
  opts = options;
  if (!lit) {
    for (const p of views) p.clear();
    active = null;
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    return;
  }
  if (!active || !views.has(active)) {
    const list = [...views].filter((p) => p.eligible && p.view.dom.isConnected);
    active = list.find((p) => p.view.hasFocus)
      || list.find((p) => p.view.dom.closest("#editor-container"))
      || list[0] || null;
  }
  for (const p of views) {
    if (p !== active) p.vis = 0;
    p.measure();
  }
  kick();
}

export function createCampfirePlugin() {
  return ViewPlugin.fromClass(CampfireView);
}
