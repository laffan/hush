/**
 * Tab-section helpers for the Outline View.
 *
 * Renders each parsed tab marker as a foldable container, nested under
 * its parent according to the marker's path. Top-level tabs sit at the
 * outline root; children indent inside their parent's body. Each
 * container's body collects every fragment whose source offset falls
 * within that tab's span — the routing function returned alongside is
 * what the main `buildContent` loop in `longview.js` calls per
 * fragment.
 */

/**
 * Build foldable tab containers and append them to `content`.
 * Returns `{ routeFor, hasMarkers }` — `routeFor(offset)` picks the
 * deepest tab body whose `startOffset` ≤ `offset`, and `hasMarkers` is
 * true when there's at least one non-root tab.
 *
 * @param {HTMLElement} content - the outline content scroller
 * @param {Array<{ title: string|null, path: string[], depth: number, label: string, startOffset: number, endOffset: number }>} tabs
 * @param {(offset: number) => void} onJumpTo - editor-jump callback
 */
export function buildTabContainers(content, tabs, onJumpTo) {
  const hasMarkers = Array.isArray(tabs) && tabs.some((t) => t?.path?.length);
  if (!hasMarkers) {
    return { hasMarkers: false, routeFor: () => content };
  }
  // Walk tabs in source order, maintaining a stack of currently-open
  // parent containers. A tab at depth D nests inside whatever is at
  // depth D-1; deeper-than-the-stack falls back to the deepest open
  // ancestor. The implicit root (path: []) is rendered without a
  // header at the outline root.
  const tabBodies = [];
  const stack = [{ depth: -1, body: content }];
  for (const t of tabs) {
    const path = t.path || [];
    const depth = path.length;
    // Pop the stack back to the parent depth so siblings share the
    // same container.
    while (stack.length > 1 && stack[stack.length - 1].depth >= depth) stack.pop();
    const parent = stack[stack.length - 1];
    const wrapper = document.createElement("div");
    wrapper.className = "longview-tab";
    if (depth >= 2) wrapper.classList.add("longview-tab-nested");
    if (path.length) {
      const header = document.createElement("div");
      header.className = "longview-tab-header";
      header.dataset.offset = String(t.startOffset);
      const chev = document.createElement("span");
      chev.className = "longview-tab-chevron";
      chev.textContent = "▾";
      chev.setAttribute("aria-label", "Toggle section");
      chev.addEventListener("click", (e) => {
        e.stopPropagation();
        wrapper.classList.toggle("collapsed");
      });
      header.appendChild(chev);
      const label = document.createElement("span");
      label.className = "longview-tab-label";
      // The outline shows just the leaf name — the hierarchy is
      // already implied by visual indentation, so repeating the
      // parent chain in every header reads as noise.
      label.textContent = t.title || "";
      header.appendChild(label);
      header.addEventListener("click", (e) => {
        if (e.target.closest(".longview-tab-chevron")) return;
        e.stopPropagation();
        onJumpTo(t.startOffset);
      });
      wrapper.appendChild(header);
    }
    const body = document.createElement("div");
    body.className = "longview-tab-body";
    wrapper.appendChild(body);
    parent.body.appendChild(wrapper);
    stack.push({ depth, body });
    tabBodies.push({ tab: t, body });
  }
  function routeFor(offset) {
    for (let i = tabBodies.length - 1; i >= 0; i--) {
      if (offset >= tabBodies[i].tab.startOffset) return tabBodies[i].body;
    }
    return tabBodies[0].body;
  }
  return { hasMarkers: true, routeFor };
}
