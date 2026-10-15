/**
 * The PDF's own outline (its bookmarks, usually a table of contents),
 * resolved to places in the pages, and the panel that shows it at the
 * viewer's left: its headings as a tree that folds, each a link to its
 * place, with the heading being read marked as the pages scroll. The
 * bottom bar's outline button (shown only when the PDF has an outline)
 * opens and closes it. Small outlines open fully; larger ones show
 * their top level. In a narrow viewer — a pane, a stack column — the
 * panel lies over the pages rather than beside them, and makes way for
 * the place it took you to.
 */

/** Book outlines run to a few hundred entries; a pathological file
 *  shouldn't stall the viewer resolving tens of thousands. */
const MAX_ENTRIES = 5000;
const MAX_DEPTH = 10;
/** Outlines this small open fully; larger ones show the top level. */
const OPEN_ALL_BELOW = 40;
/** Narrower than this, the panel lies over the pages. */
const OVERLAY_BELOW = 700;

const CHEVRON_RIGHT = `<svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M6 4 L10 8 L6 12"/></svg>`;
const CHEVRON_DOWN = `<svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6 L8 10 L12 6"/></svg>`;
const CLOSE = `<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M4 4 L12 12 M12 4 L4 12"/></svg>`;

async function resolveDest(doc, dest) {
  const none = { pageIndex: null, top: null };
  try {
    const explicit = typeof dest === "string" ? await doc.getDestination(dest) : dest;
    if (!Array.isArray(explicit) || explicit[0] == null) return none;
    const ref = explicit[0];
    // Usually a page reference; some files give the page index itself.
    const pageIndex = typeof ref === "number" ? ref : typeof ref === "object" ? await doc.getPageIndex(ref) : null;
    if (pageIndex == null || pageIndex < 0 || pageIndex >= doc.numPages) return none;
    // [page, /XYZ, left, top, zoom] · [page, /FitH, top] ·
    // [page, /FitR, left, bottom, right, top]
    const kind = explicit[1]?.name;
    const raw = kind === "XYZ" ? explicit[3] : kind === "FitH" || kind === "FitBH" ? explicit[2] : kind === "FitR" ? explicit[5] : null;
    return { pageIndex, top: typeof raw === "number" && Number.isFinite(raw) ? raw : null };
  } catch (_) {
    return none;
  }
}

/** The document's outline, resolved: `[{ title, pageIndex, top, children }]`
 *  (`pageIndex` null for a destination that can't be resolved, `top` in
 *  PDF user space or null for the page's top); empty when it has none. */
export async function readOutline(doc) {
  const raw = (await doc.getOutline().catch(() => null)) || [];
  let budget = MAX_ENTRIES;
  const walk = async (nodes, depth) => {
    const take = nodes.slice(0, Math.max(0, budget));
    budget -= take.length;
    return Promise.all(take.map(async (n) => ({
      title: String(n.title ?? "").replace(/\s+/g, " ").trim() || "(untitled)",
      ...(await resolveDest(doc, n.dest)),
      children: depth < MAX_DEPTH && n.items?.length ? await walk(n.items, depth + 1) : [],
    })));
  };
  return walk(raw, 0);
}

/** The headings with a place, in reading order, each with its id (its
 *  path of indexes in the tree, "2.0.1"). Entries at the same spot keep
 *  their outline order, so the deeper heading is the later one. */
function sectionsOf(outline) {
  const out = [];
  const walk = (list, id) => list.forEach((e, i) => {
    const eid = id ? `${id}.${i}` : String(i);
    if (e.pageIndex != null) out.push({ id: eid, pageIndex: e.pageIndex, top: e.top ?? Infinity, i: out.length });
    walk(e.children, eid);
  });
  walk(outline, "");
  return out.sort((a, b) => a.pageIndex - b.pageIndex || b.top - a.top || a.i - b.i);
}

const countEntries = (list) => list.reduce((n, e) => n + 1 + countEntries(e.children), 0);

/**
 * @param {HTMLElement} body  The viewer body (the panel goes first in it)
 * @param {object} env
 * @param {function} env.goTo        (pageIndex, top) => void
 * @param {function} env.currentPage () => number (1-based)
 * @param {function} env.onToggle    (open) => void — shown or hidden
 */
export function createOutlinePanel(body, env) {
  let outline = [];
  let sections = [];
  let expanded = new Set();
  let open = false;
  let current = null;

  const panel = document.createElement("nav");
  panel.className = "pdf-outline-panel";
  panel.setAttribute("aria-label", "Outline");
  panel.style.display = "none";
  panel.innerHTML = `<div class="pdf-outline-head"><span>Contents</span>
    <button type="button" class="pdf-outline-close" aria-label="Hide the outline" title="Hide the outline">${CLOSE}</button></div>
    <div class="pdf-outline-list"></div>`;
  const list = panel.querySelector(".pdf-outline-list");
  panel.querySelector(".pdf-outline-close").addEventListener("click", () => setOpen(false));
  body.insertBefore(panel, body.firstChild);

  const overlaid = () => body.clientWidth < OVERLAY_BELOW;

  function render() {
    list.innerHTML = "";
    const rows = (entries, depth, parent) => entries.forEach((e, i) => {
      const id = parent ? `${parent}.${i}` : String(i);
      const isOpen = expanded.has(id);
      const row = document.createElement("div");
      row.className = "pdf-outline-row" + (e.pageIndex == null ? " dead" : "");
      row.dataset.id = id;
      row.style.paddingLeft = `${6 + depth * 12}px`;
      row.title = e.title;
      const toggle = document.createElement(e.children.length ? "button" : "span");
      toggle.className = "pdf-outline-toggle";
      if (e.children.length) {
        toggle.type = "button";
        toggle.innerHTML = isOpen ? CHEVRON_DOWN : CHEVRON_RIGHT;
        toggle.setAttribute("aria-label", isOpen ? "Collapse" : "Expand");
        toggle.addEventListener("click", (ev) => {
          ev.stopPropagation();
          if (!expanded.delete(id)) expanded.add(id);
          render();
        });
      }
      const title = document.createElement("span");
      title.className = "pdf-outline-title";
      title.textContent = e.title;
      row.append(toggle, title);
      if (e.pageIndex != null) {
        const page = document.createElement("span");
        page.className = "pdf-outline-page";
        page.textContent = String(e.pageIndex + 1);
        row.appendChild(page);
        row.addEventListener("click", () => {
          env.goTo(e.pageIndex, e.top);
          if (overlaid()) setOpen(false);
        });
      }
      list.appendChild(row);
      if (isOpen) rows(e.children, depth + 1, id);
    });
    rows(outline, 0, "");
    current = null;
    markCurrent();
  }

  /** Mark the heading being read — or, while it is folded away, the
   *  nearest heading above it that is showing — and keep it in sight by
   *  scrolling the list itself (scrollIntoView could also cut short the
   *  pages' own smooth scroll). */
  function markCurrent() {
    if (!open || !sections.length) return;
    const page = env.currentPage();
    let at = -1;
    for (let i = 0; i < sections.length && sections[i].pageIndex <= page - 1; i++) at = i;
    let id = null;
    if (at >= 0) {
      const parts = sections[at].id.split(".");
      id = parts[0];
      for (let i = 1; i < parts.length && expanded.has(id); i++) id = `${id}.${parts[i]}`;
    }
    if (id === current) return;
    current = id;
    list.querySelector(".pdf-outline-row.current")?.classList.remove("current");
    const row = id ? list.querySelector(`.pdf-outline-row[data-id="${id}"]`) : null;
    if (!row) return;
    row.classList.add("current");
    const lr = list.getBoundingClientRect();
    const rr = row.getBoundingClientRect();
    if (rr.top < lr.top) list.scrollTop -= lr.top - rr.top + 8;
    else if (rr.bottom > lr.bottom) list.scrollTop += rr.bottom - lr.bottom + 8;
  }

  function setOpen(on) {
    on = on && outline.length > 0;
    if (on === open) return;
    open = on;
    panel.style.display = on ? "" : "none";
    panel.classList.toggle("overlay", on && overlaid());
    if (on) render();
    env.onToggle?.(on);
  }

  return {
    /** The outline, once read (empty: the PDF has none). */
    setOutline(entries) {
      outline = entries || [];
      sections = sectionsOf(outline);
      expanded = new Set();
      if (countEntries(outline) < OPEN_ALL_BELOW) {
        const walk = (l, id) => l.forEach((e, i) => {
          const eid = id ? `${id}.${i}` : String(i);
          if (e.children.length) expanded.add(eid);
          walk(e.children, eid);
        });
        walk(outline, "");
      }
      if (!outline.length) setOpen(false);
      else if (open) render();
    },
    has: () => outline.length > 0,
    isOpen: () => open,
    setOpen,
    toggle: () => setOpen(!open),
    /** The page in view changed. */
    onPage: markCurrent,
    destroy: () => panel.remove(),
  };
}
