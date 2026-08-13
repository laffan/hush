/**
 * Zotero library browser — the folder tree + item list that sits under
 * the search box in every "pick something from Zotero" surface (Save
 * PDF, the highlight browser, Insert Reference).
 *
 * The search box on its own only works if you can already name what
 * you're after. The tree gives the other half: "All Items" at the top
 * (selected by default, so the surface opens exactly as it did before),
 * then the library's collections, with the selected folder's items on
 * the right.
 *
 * ## Contract with hosts
 *
 * `createLibraryBrowser({ host, refs, collections, onChange })` replaces
 * the contents of `host` with the two-pane layout and hands back
 * `{ itemsEl, scopedRefs(), destroy() }`. The host keeps rendering its
 * own rows — every surface paints them differently (checkboxes, radio
 * targets, plain rows) — into `itemsEl`, and keeps its own click
 * handling; delegated listeners already bound on `host` still fire,
 * since `itemsEl` is a descendant. On a folder click the browser calls
 * `onChange`, and the host re-runs its usual "filter by the query, paint
 * the rows" pass, this time over `scopedRefs()`.
 *
 * Selecting a folder includes items in its subfolders. Zotero's own UI
 * defaults the other way, but here the tree exists to narrow a search
 * for one paper — "it's somewhere under Dissertation" is the question
 * being asked, and an empty parent folder answers it badly.
 */

const ALL_ITEMS = "__all__";

/** Build `parentKey → children[]` and `key → collection` indexes once,
 *  sorted by name so the tree renders in a stable, readable order. */
function indexCollections(collections) {
  const byParent = new Map();
  const byKey = new Map();
  for (const c of collections || []) {
    if (!c?.key) continue;
    byKey.set(c.key, c);
    const parent = c.parentKey || null;
    if (!byParent.has(parent)) byParent.set(parent, []);
    byParent.get(parent).push(c);
  }
  for (const list of byParent.values()) {
    list.sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  }
  return { byParent, byKey };
}

export function createLibraryBrowser({ host, refs, collections, onChange }) {
  const { byParent, byKey } = indexCollections(collections);
  const hasTree = byKey.size > 0;

  let selected = ALL_ITEMS;
  const expanded = new Set();

  host.innerHTML = `
    <div class="zlib${hasTree ? "" : " zlib-no-tree"}">
      ${hasTree ? '<div class="zlib-tree" role="tree" aria-label="Zotero collections"></div>' : ""}
      <div class="zlib-items"></div>
    </div>`;
  const treeEl = host.querySelector(".zlib-tree");
  const itemsEl = host.querySelector(".zlib-items");

  /** Every collection key at or below `key` — the selection's scope. */
  function descendants(key) {
    const out = new Set([key]);
    const walk = (k) => {
      for (const child of byParent.get(k) || []) {
        if (out.has(child.key)) continue; // cycle guard: sync can lie
        out.add(child.key);
        walk(child.key);
      }
    };
    walk(key);
    return out;
  }

  /** How many items are in a collection and everything under it —
   *  drawn beside the folder name so an empty branch reads as empty
   *  before you click it. Memoized: the tree re-renders on every
   *  expand and select, and this walks the whole library per row. */
  const counts = new Map();
  function countFor(key) {
    let n = counts.get(key);
    if (n !== undefined) return n;
    const scope = descendants(key);
    n = 0;
    for (const r of refs) {
      if ((r.collections || []).some((c) => scope.has(c))) n++;
    }
    counts.set(key, n);
    return n;
  }

  function rowHtml(c, depth) {
    const kids = byParent.get(c.key) || [];
    const open = expanded.has(c.key);
    return `
      <div class="zlib-row${selected === c.key ? " selected" : ""}"
           role="treeitem" tabindex="0" data-key="${escAttr(c.key)}"
           aria-selected="${selected === c.key}"
           ${kids.length ? `aria-expanded="${open}"` : ""}
           style="--zlib-depth:${depth}">
        ${kids.length
          ? `<button type="button" class="zlib-twisty${open ? " open" : ""}"
                     data-twisty="${escAttr(c.key)}"
                     aria-label="${open ? "Collapse" : "Expand"} ${escAttr(c.name)}">▸</button>`
          : '<span class="zlib-twisty-spacer"></span>'}
        <span class="zlib-row-name">${escHtml(c.name)}</span>
        <span class="zlib-row-count">${countFor(c.key)}</span>
      </div>
      ${open ? kids.map((k) => rowHtml(k, depth + 1)).join("") : ""}`;
  }

  function renderTree() {
    if (!treeEl) return;
    const roots = byParent.get(null) || [];
    treeEl.innerHTML = `
      <div class="zlib-row zlib-row-all${selected === ALL_ITEMS ? " selected" : ""}"
           role="treeitem" tabindex="0" data-key="${ALL_ITEMS}"
           aria-selected="${selected === ALL_ITEMS}" style="--zlib-depth:0">
        <span class="zlib-twisty-spacer"></span>
        <span class="zlib-row-name">All Items</span>
        <span class="zlib-row-count">${refs.length}</span>
      </div>
      ${roots.map((c) => rowHtml(c, 0)).join("")}`;
  }

  if (treeEl) {
    treeEl.addEventListener("click", (e) => {
      const twisty = e.target.closest("[data-twisty]");
      if (twisty) {
        // Disclosure only — expanding a folder shouldn't move the
        // selection out from under whatever list the user is reading.
        e.stopPropagation();
        const key = twisty.dataset.twisty;
        if (expanded.has(key)) expanded.delete(key);
        else expanded.add(key);
        renderTree();
        return;
      }
      const row = e.target.closest(".zlib-row");
      if (!row) return;
      selected = row.dataset.key;
      renderTree();
      if (typeof onChange === "function") onChange(selected);
    });
    treeEl.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      const row = e.target.closest(".zlib-row");
      if (!row) return;
      e.preventDefault();
      selected = row.dataset.key;
      renderTree();
      if (typeof onChange === "function") onChange(selected);
    });
  }

  renderTree();

  return {
    itemsEl,
    /** The references the current folder selection admits. */
    scopedRefs() {
      if (selected === ALL_ITEMS || !byKey.has(selected)) return refs;
      const scope = descendants(selected);
      return refs.filter((r) => (r.collections || []).some((c) => scope.has(c)));
    },
    selectedKey() { return selected; },
    destroy() { host.innerHTML = ""; },
  };
}

function escHtml(str) {
  const div = document.createElement("div");
  div.textContent = str == null ? "" : String(str);
  return div.innerHTML;
}

function escAttr(str) {
  return escHtml(str).replace(/"/g, "&quot;");
}
