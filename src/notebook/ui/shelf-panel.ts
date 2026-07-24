import type { DrawingState } from "../state";
import type { Shape, TextShape } from "../types";
import { getShapeBounds } from "../utils";
import { h, clearChildren } from "./dom-helpers";
import { icon } from "./icons";
import {
  buildLabel, renderLabelInline, allFlagHexes, getHushFlagColors,
  getDesktopSearchText, appendWithSearchHighlight, findContentMatches, buildSnippet,
} from "./shelf-label";
import { perf } from "../perf-hud"; // PERF-HUD (temporary)

interface ShelfNode {
  id: string; type: string; label: string; excerpt: string;
  color: string | null; shapeId: string; parentId: string | undefined; depth: number;
  pocketed: boolean;
  /** Desktop file thumbnails: the underlying file's kind ("doc" |
   *  "notebook" | "pdf" | "stack" | "project"). Drives the filetype
   *  icon on the row; the file's deep content (doc body / notebook
   *  text / PDF annotations) rides in `excerpt` so search reaches it. */
  fileKind?: string;
  /** True when this text shape participates in a flowchart (has at
   *  least one in/out edge). Drives the small arrow indicator and is
   *  also used as the indented-tree signal. */
  flow?: boolean;
  /** First line is a markdown heading (`#`..`######` followed by a space).
   *  The `#` markers are stripped from `label` and the row renders bold. */
  heading?: boolean;
  /** First line is a markdown blockquote (`> ...`). The `>` is stripped
   *  from `label` and the row paints a left rule + soft background. */
  blockquote?: boolean;
  /** Pre-computed flag hex colour for this node. For text nodes it comes
   *  from the node's own label; for drag-area nodes it bubbles up from
   *  the first flagged text child. Used by `makeNodeRow` to paint the
   *  leading dot. */
  flagHexes?: string[];
}

interface ShelfPaneInfo {
  id: string;
  fileName: string;
  fileType: string;
  content: string;
  attached: boolean;
  pinned: boolean;
}

export function createShelfPanel(
  state: DrawingState,
  opts: {
    getPanes?: () => ShelfPaneInfo[];
    onFocusPane?: (id: string) => void;
    onScrollPaneToMatch?: (id: string, from: number, to: number) => void;
    initialWidth?: number;
  },
): HTMLElement {
  let isOpen = false;
  let search = "";
  let activeTag: string | null = null;
  const collapsed = new Set<string>();
  const pinned = new Set<string>();
  let openWidth = Math.max(200, opts.initialWidth ?? 280);

  const panel = h("div", {
    style: { position: "absolute", top: "calc(env(safe-area-inset-top) + 20px + var(--pane-dock-top-height, 0px))", right: "calc(env(safe-area-inset-right) + var(--pane-dock-right-width, 0px))", bottom: "calc(env(safe-area-inset-bottom) + 20px + var(--pane-dock-bottom-height, 0px))", zIndex: "150", display: "flex", flexDirection: "column", transition: "width 0.2s", overflow: "hidden", width: "24px", minWidth: "24px", borderRadius: "12px 0 0 12px" },
  });
  panel.classList.add("notebook-shelf");

  const grip = h("button", {
    text: "\u2039",
    style: { width: "24px", height: "100%", position: "absolute", left: "0", top: "0", border: "none", borderRight: "none", borderRadius: "12px 0 0 12px", cursor: "pointer", fontSize: "12px", display: "flex", alignItems: "center", justifyContent: "center", zIndex: "10" },
    onClick: () => { isOpen = !isOpen; rebuild(); },
  });
  panel.appendChild(grip);

  const content = h("div", {
    style: { marginLeft: "24px", flex: "1", display: "flex", flexDirection: "column", overflow: "hidden", padding: "20px 20px 20px 0" },
  });
  panel.appendChild(content);

  // Persistent search container (kept across rebuilds so the input keeps
  // focus while the user types).
  const searchContainer = h("div", { style: { position: "relative", marginBottom: "8px" } });
  const searchInput = h("input", { attrs: { type: "text", placeholder: "Search..." }, style: { width: "100%", padding: "6px 28px 6px 8px", borderRadius: "6px", fontSize: "13px", outline: "none", boxSizing: "border-box" } }) as HTMLInputElement;
  searchContainer.appendChild(searchInput);
  searchInput.addEventListener("input", () => { search = searchInput.value; rebuildBody(); });
  let searchClearBtn: HTMLButtonElement | null = null;

  // Body holds everything below the search input; cleared on every rebuild.
  const body = h("div", { style: { flex: "1", display: "flex", flexDirection: "column", overflow: "hidden" } });

  function t() { return state.theme; }

  function applyTheme() {
    const theme = t();
    panel.style.background = theme.uiBackground;
    // Use the app's UI font (matches the file sidebar) rather than the
    // active style's editor font, which would otherwise cascade in via
    // the canvas's `--font-family`.
    panel.style.fontFamily = "var(--ui-font-family)";
    // Match the files sidebar's subtle panel border (--panel-border) rather
    // than the fainter canvas grid colour so the two read consistently.
    const panelBorder = getComputedStyle(document.documentElement)
      .getPropertyValue("--panel-border").trim()
      || (theme.variant === "dark" ? "rgba(255,255,255,0.12)" : "rgba(0,0,0,0.12)");
    panel.style.border = `1px solid ${panelBorder}`;
    panel.style.borderRight = "none";
    grip.style.background = "transparent";
    grip.style.borderColor = "transparent";
    grip.style.color = theme.foreground;
  }

  function buildNodes(shapes: Shape[]): ShelfNode[] {
    const result: ShelfNode[] = [];
    const flow = state.flowchart;
    const dragAreas = shapes.filter((s) => s.type === "drag-area");
    const others = shapes.filter((s) => s.type === "text" || s.type === "image");
    const byId = new Map<string, Shape>(shapes.map((s) => [s.id, s]));

    const isFlowParticipant = (id: string) =>
      flow.parentOf(id) !== null || flow.childrenOf(id).length > 0;

    function pushTextNode(s: TextShape, parentScopeId: string | undefined, depth: number) {
      const { label, heading, blockquote } = buildLabel(s.text, 50);
      result.push({
        id: s.id, type: "text",
        label, excerpt: s.text, color: s.backgroundColor || null,
        shapeId: s.id, parentId: parentScopeId, depth, pocketed: !!s.pocketed,
        flow: isFlowParticipant(s.id), heading, blockquote,
      });
    }

    /** Walk every flow child of `parentId` whose shape is in `scope`,
     *  pushing each as a text row under the current outline. Recurses
     *  depth-first so the rendered list mirrors the flowchart tree. */
    function walkFlowChildren(parentId: string, scope: Set<string>, parentScopeId: string | undefined, depth: number) {
      const childIds = flow.childrenOf(parentId).filter((id) => scope.has(id));
      const childShapes = childIds
        .map((id) => byId.get(id))
        .filter((s): s is TextShape => !!s && s.type === "text");
      childShapes.sort((a, b) => {
        const ab = getShapeBounds(a); const bb = getShapeBounds(b);
        return ab.minY - bb.minY || ab.minX - bb.minX;
      });
      for (const c of childShapes) {
        pushTextNode(c, parentScopeId, depth);
        walkFlowChildren(c.id, scope, parentScopeId, depth + 1);
      }
    }

    for (const da of dragAreas) {
      const children = shapes.filter((s) => s.parentId === da.id);
      const textChildren = children.filter((s) => s.type === "text");
      let name = `(${children.length} items)`;
      if (textChildren.length > 0) {
        const sorted = [...textChildren].sort((a, b) => { const ab = getShapeBounds(a); const bb = getShapeBounds(b); return ab.minY - bb.minY || ab.minX - bb.minX; });
        if (sorted[0].type === "text") name = buildLabel(sorted[0].text, 40).label;
      }
      // Bubble up: collect all flag colours from text children so the
      // drag-area row shows flag dots even when its own label has none.
      const _flagColors = getHushFlagColors();
      const daFlagHexes: string[] = [];
      const _seen = new Set<string>();
      for (const child of textChildren) {
        if (child.type === "text") {
          for (const hex of allFlagHexes(child.text, _flagColors)) {
            if (!_seen.has(hex)) { _seen.add(hex); daFlagHexes.push(hex); }
          }
        }
      }
      result.push({ id: da.id, type: "drag-area", label: name, excerpt: "", color: da.type === "drag-area" ? da.strokeColor : null, shapeId: da.id, parentId: undefined, depth: 0, pocketed: !!da.pocketed, flagHexes: daFlagHexes.length ? daFlagHexes : undefined });
      if (!collapsed.has(da.id)) {
        const sortedChildren = [...children].sort((a, b) => { const ab = getShapeBounds(a); const bb = getShapeBounds(b); return ab.minY - bb.minY || ab.minX - bb.minX; });
        const scope = new Set(children.map((c) => c.id));
        for (const child of sortedChildren) {
          if (child.type === "text") {
            // If this text shape's flow parent is in the same scope it
            // will be rendered nested under that parent — skip the flat
            // pass to avoid duplication.
            const fp = flow.parentOf(child.id);
            if (fp && scope.has(fp)) continue;
            pushTextNode(child, da.id, 1);
            walkFlowChildren(child.id, scope, da.id, 2);
          } else if (child.type === "image") {
            const fr = child.fileRef;
            result.push({ id: child.id, type: "image", label: child.name || "Image", excerpt: fr ? getDesktopSearchText(fr.key) : "", color: null, shapeId: child.id, parentId: da.id, depth: 1, pocketed: !!child.pocketed, fileKind: fr?.kind });
          }
        }
      }
    }

    const rootOthers = others.filter((s) => !s.parentId).sort((a, b) => { const ab = getShapeBounds(a); const bb = getShapeBounds(b); return ab.minY - bb.minY || ab.minX - bb.minX; });
    const rootScope = new Set(rootOthers.map((s) => s.id));
    const emittedStacks = new Set<string>();
    for (const s of rootOthers) {
      if (s.type === "text") {
        if (!s.text.trim()) continue;
        const fp = flow.parentOf(s.id);
        if (fp && rootScope.has(fp)) continue;
        pushTextNode(s, undefined, 0);
        walkFlowChildren(s.id, rootScope, undefined, 1);
      } else if (s.type === "image") {
        const fr = s.fileRef;
        // Desktop thumbnail piles render like drag-areas: a collapsible
        // parent row with the members indented beneath it, in pile order
        // (= shapes array order).
        const sid = fr?.stackId;
        if (sid) {
          if (emittedStacks.has(sid)) continue;
          emittedStacks.add(sid);
          const members = shapes.filter(
            (m): m is Shape & { type: "image" } => m.type === "image" && m.fileRef?.stackId === sid,
          );
          const groupId = "stack:" + sid;
          result.push({
            id: groupId, type: "thumb-stack", label: `${members.length} stacked`, excerpt: "",
            color: null, shapeId: members[0]?.id || s.id, parentId: undefined, depth: 0, pocketed: false,
          });
          if (!collapsed.has(groupId)) {
            for (const m of members) {
              const mfr = m.fileRef;
              result.push({ id: m.id, type: "image", label: m.name || "Image", excerpt: mfr ? getDesktopSearchText(mfr.key) : "", color: null, shapeId: m.id, parentId: groupId, depth: 1, pocketed: !!m.pocketed, fileKind: mfr?.kind });
            }
          }
          continue;
        }
        result.push({ id: s.id, type: "image", label: s.name || "Image", excerpt: fr ? getDesktopSearchText(fr.key) : "", color: null, shapeId: s.id, parentId: undefined, depth: 0, pocketed: !!s.pocketed, fileKind: fr?.kind });
      }
    }
    return result;
  }

  function applySearchTheme() {
    const theme = t();
    const fg = theme.foreground;
    const muted = theme.variant === "dark" ? "rgba(255,255,255,0.4)" : "#888";
    const inputBg = theme.variant === "dark" ? "rgba(255,255,255,0.06)" : "#fff";
    const inputBorder = theme.variant === "dark" ? "rgba(255,255,255,0.12)" : "#e5e7eb";
    searchInput.style.border = `1px solid ${inputBorder}`;
    searchInput.style.background = inputBg;
    searchInput.style.color = fg;
    if (search && !searchClearBtn) {
      searchClearBtn = h("button", { text: "\u00d7", style: { position: "absolute", right: "14px", top: "50%", transform: "translateY(-50%)", border: "none", background: "none", cursor: "pointer", fontSize: "16px", color: muted }, onClick: () => { search = ""; searchInput.value = ""; rebuildBody(); } }) as HTMLButtonElement;
      searchContainer.appendChild(searchClearBtn);
    } else if (!search && searchClearBtn) {
      searchClearBtn.remove();
      searchClearBtn = null;
    } else if (searchClearBtn) {
      searchClearBtn.style.color = muted;
    }
  }

  function rebuild() { // PERF-HUD (temporary) wrapper — runs on EVERY change event
    perf.begin("ui:shelf"); try { rebuildInner(); } finally { perf.end("ui:shelf"); }
  }

  function rebuildInner() {
    applyTheme();

    panel.style.width = isOpen ? `${openWidth}px` : "24px";
    panel.style.minWidth = isOpen ? `${openWidth}px` : "24px";
    grip.textContent = isOpen ? "\u203a" : "\u2039";
    content.style.display = isOpen ? "flex" : "none";
    if (!isOpen) {
      // Detach header/body so a closed shelf doesn't leave them in the DOM.
      if (searchContainer.parentElement === content) content.removeChild(searchContainer);
      if (body.parentElement === content) content.removeChild(body);
      return;
    }

    // Mount persistent header/body once per open.
    if (searchContainer.parentElement !== content) content.appendChild(searchContainer);
    if (body.parentElement !== content) content.appendChild(body);

    applySearchTheme();
    rebuildBody();
  }

  function rebuildBody() {
    const theme = t();
    const fg = theme.foreground;
    const muted = theme.variant === "dark" ? "rgba(255,255,255,0.4)" : "#888";
    const border = theme.uiBorder;
    const subtleBorder = theme.variant === "dark" ? "rgba(255,255,255,0.04)" : "#f8f9fa";

    applySearchTheme();
    clearChildren(body);

    const nodes = buildNodes(state.shapes);

    // Tags
    const tags = new Set<string>();
    const tagRegex = /#([\w-]+)/g;
    for (const n of nodes) { let m; while ((m = tagRegex.exec(n.excerpt)) !== null) tags.add(m[1]); }
    const sortedTags = Array.from(tags).sort();
    if (sortedTags.length > 0) {
      const tagBar = h("div", { style: { display: "flex", flexWrap: "wrap", gap: "4px", paddingBottom: "8px" } });
      for (const tag of sortedTags) {
        const active = activeTag === tag;
        tagBar.appendChild(h("button", { text: `#${tag}`, style: { padding: "2px 8px", border: "none", borderRadius: "10px", fontSize: "11px", cursor: "pointer", background: active ? theme.accent : (theme.variant === "dark" ? "rgba(255,255,255,0.08)" : "#f1f3f5"), color: active ? "#fff" : muted }, onClick: () => { activeTag = activeTag === tag ? null : tag; rebuildBody(); } }));
      }
      body.appendChild(tagBar);
    }

    // Filter
    let filtered = nodes;
    if (search.trim()) { const q = search.toLowerCase(); filtered = filtered.filter((n) => n.label.toLowerCase().includes(q) || n.excerpt.toLowerCase().includes(q)); }
    if (activeTag) filtered = filtered.filter((n) => n.excerpt.includes(`#${activeTag}`));

    const pinnedItems = filtered.filter((n) => pinned.has(n.id));
    const unpinnedItems = filtered.filter((n) => !pinned.has(n.id));

    // Pinned
    if (pinnedItems.length > 0) {
      const section = h("div", { style: { padding: "4px 0", borderBottom: `1px solid ${border}` } });
      const pinnedHeader = h("div", { style: { fontSize: "11px", fontWeight: "600", color: muted, textTransform: "uppercase", letterSpacing: "0.5px", padding: "4px 0", display: "flex", alignItems: "center", gap: "4px" } });
      const pinnedIcon = icon("pin", 11);
      pinnedIcon.style.color = muted;
      pinnedHeader.appendChild(pinnedIcon);
      pinnedHeader.appendChild(document.createTextNode("Pinned"));
      section.appendChild(pinnedHeader);
      pinnedItems.forEach((n) => section.appendChild(makeNodeRow(n, true)));
      body.appendChild(section);
    }

    // Pane rows — pinned canvas panes show alongside shapes and their
    // contents are searchable from the same input. The list is read live
    // from the pane manager so editor edits are picked up on every
    // rebuild (search input, shape change, pane create/close).
    const allPanes = opts.getPanes ? opts.getPanes() : [];
    const q = search.trim().toLowerCase();
    const visiblePanes = allPanes.filter((p) => {
      if (q) {
        const haystack = `${p.fileName}\n${p.content}`.toLowerCase();
        if (!haystack.includes(q)) return false;
      }
      if (activeTag && !p.content.includes(`#${activeTag}`)) return false;
      return true;
    });
    if (visiblePanes.length > 0) {
      const section = h("div", { style: { padding: "4px 0", borderBottom: `1px solid ${border}` } });
      section.appendChild(h("div", { text: "Panes", style: { fontSize: "11px", fontWeight: "600", color: muted, textTransform: "uppercase", letterSpacing: "0.5px", padding: "4px 0" } }));
      for (const p of visiblePanes) {
        section.appendChild(makePaneRow(p));
        // Doc panes get per-match drill-downs when the user is searching:
        // each match shows a snippet and jumps the pane to that range
        // on click. Notebook panes store JSON, so character positions
        // wouldn't map to a meaningful place — skip them.
        if (q && p.fileType !== "notebook" && opts.onScrollPaneToMatch) {
          const matches = findContentMatches(p.content, q, 20);
          for (const m of matches) section.appendChild(makePaneMatchRow(p, m, q));
        }
      }
      body.appendChild(section);
    }

    // All items
    const scrollArea = h("div", { style: { flex: "1", overflowY: "auto", padding: "4px 0" } });
    if (unpinnedItems.length === 0 && visiblePanes.length === 0) {
      scrollArea.appendChild(h("div", { text: "No items. Add shapes to the canvas.", style: { padding: "16px", textAlign: "center", fontSize: "12px", color: muted } }));
    }
    unpinnedItems.forEach((n) => scrollArea.appendChild(makeNodeRow(n, false)));
    body.appendChild(scrollArea);
  }

  function makePaneMatchRow(p: ShelfPaneInfo, match: { start: number; }, q: string): HTMLElement {
    const theme = t();
    const fg = theme.foreground;
    const muted = theme.variant === "dark" ? "rgba(255,255,255,0.4)" : "#999";
    const subtleBorder = theme.variant === "dark" ? "rgba(255,255,255,0.04)" : "#f8f9fa";
    const highlightBg = theme.variant === "dark" ? "rgba(255, 224, 102, 0.25)" : "rgba(255, 213, 0, 0.35)";

    const row = h("div", {
      style: {
        display: "flex", alignItems: "center", gap: "6px", padding: "3px 0 3px 28px",
        cursor: "pointer", fontSize: "12px", borderBottom: `1px solid ${subtleBorder}`,
        color: fg, lineHeight: "1.35",
      },
    });
    const snippet = buildSnippet(p.content, match.start, q.length, muted, highlightBg);
    row.appendChild(snippet);
    row.addEventListener("click", () => {
      if (opts.onScrollPaneToMatch) opts.onScrollPaneToMatch(p.id, match.start, match.start + q.length);
    });
    return row;
  }

  function makePaneRow(p: ShelfPaneInfo): HTMLElement {
    const theme = t();
    const fg = theme.foreground;
    const muted = theme.variant === "dark" ? "rgba(255,255,255,0.4)" : "#999";
    const subtleBorder = theme.variant === "dark" ? "rgba(255,255,255,0.04)" : "#f8f9fa";
    const row = h("div", {
      style: {
        display: "flex", alignItems: "center", gap: "6px", padding: "4px 0", cursor: "pointer",
        fontSize: "13px", borderBottom: `1px solid ${subtleBorder}`,
        borderLeft: "3px solid transparent", color: fg,
      },
    });
    const tag = h("span", {
      text: p.fileType === "notebook" ? "NB" : "DOC",
      style: {
        fontSize: "9px", fontWeight: "600", letterSpacing: "0.5px",
        padding: "2px 5px", borderRadius: "4px",
        background: theme.variant === "dark" ? "rgba(255,255,255,0.08)" : "#f1f3f5",
        color: muted, flexShrink: "0",
      },
    });
    row.appendChild(tag);
    const nameSpan = h("span", {
      style: { flex: "1", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
    });
    const highlightBg = theme.variant === "dark" ? "rgba(255, 224, 102, 0.25)" : "rgba(255, 213, 0, 0.35)";
    appendWithSearchHighlight(nameSpan, p.fileName || "Untitled", search.trim(), highlightBg);
    row.appendChild(nameSpan);
    row.addEventListener("click", () => { if (opts.onFocusPane) opts.onFocusPane(p.id); });
    return row;
  }

  function makeNodeRow(node: ShelfNode, isPinned: boolean): HTMLElement {
    const theme = t();
    const fg = theme.foreground;
    const muted = theme.variant === "dark" ? "rgba(255,255,255,0.4)" : "#999";
    const subtleBorder = theme.variant === "dark" ? "rgba(255,255,255,0.04)" : "#f8f9fa";
    const flagColors = getHushFlagColors();
    const flagHexes = allFlagHexes(node.excerpt || node.label, flagColors);
    if (!flagHexes.length && node.flagHexes) flagHexes.push(...node.flagHexes);
    const isSelected = state.selectedIds.has(node.shapeId);
    const selectedBg = theme.variant === "dark" ? "rgba(120, 180, 255, 0.14)" : "rgba(66, 133, 244, 0.12)";
    const rowBg = isSelected ? selectedBg : "transparent";
    const row = h("div", { style: { display: "flex", alignItems: "center", gap: "4px", padding: "4px 0", cursor: "pointer", fontSize: "13px", borderBottom: `1px solid ${subtleBorder}`, paddingLeft: (node.depth * 16) + "px", color: fg, background: rowBg } });
    if (node.type === "drag-area" || node.type === "thumb-stack") {
      row.appendChild(h("button", { text: collapsed.has(node.id) ? "\u25b8" : "\u25be", style: { border: "none", background: "none", cursor: "pointer", fontSize: "10px", color: muted, padding: "0", width: "16px" }, onClick: () => { if (collapsed.has(node.id)) collapsed.delete(node.id); else collapsed.add(node.id); rebuildBody(); } }));
    }
    if (node.type === "drag-area" || node.type === "thumb-stack") {
      const daIcon = icon(node.type === "drag-area" ? "drag-area" : "layers-stack", 12);
      daIcon.style.flexShrink = "0";
      daIcon.style.color = muted;
      daIcon.style.marginRight = "2px";
      row.appendChild(daIcon);
    }
    if (node.fileKind) {
      // Desktop file thumbnails carry their filetype glyph (mirrors the
      // files sidebar) so the shelf reads as a mini file list.
      const kindIcon = icon("file-" + node.fileKind, 12);
      kindIcon.style.flexShrink = "0";
      kindIcon.style.color = muted;
      kindIcon.style.marginRight = "2px";
      row.appendChild(kindIcon);
    }
    if (node.pocketed) {
      const pocketIcon = icon("pocket", 12);
      pocketIcon.style.flexShrink = "0";
      pocketIcon.style.color = muted;
      pocketIcon.style.marginRight = "2px";
      row.appendChild(pocketIcon);
    }
    if (node.flow) {
      const arrow = h("span", {
        text: "→",
        style: { flexShrink: "0", color: muted, fontSize: "11px", marginRight: "2px", lineHeight: "1" },
      });
      row.appendChild(arrow);
    }
    for (const hex of flagHexes) {
      row.appendChild(h("span", {
        style: { flexShrink: "0", width: "10px", height: "10px", borderRadius: "50%", background: hex, display: "inline-block" },
      }));
    }
    row.setAttribute("data-shelf-row", "1");
    row.setAttribute("data-shape-id", node.shapeId);
    // Heading rows pick up the same heading colour the canvas renderer
    // uses (theme.headingColor) so the shelf reads as a coloured outline.
    const labelColor = node.heading ? theme.headingColor : fg;
    const labelSpan = h("span", {
      attrs: { "data-shelf-row-label": "1" },
      style: {
        flex: "1", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
        cursor: "pointer",
        color: labelColor,
        fontWeight: node.heading ? "600" : "400",
        fontStyle: node.blockquote ? "italic" : "normal",
      },
      onClick: () => state.focusShape(node.shapeId, undefined, isOpen ? panel.offsetWidth : 0),
    });
    const searchHlBg = theme.variant === "dark" ? "rgba(255, 224, 102, 0.25)" : "rgba(255, 213, 0, 0.35)";
    const q = search.trim();
    // When a search is active and the match only exists in the body
    // (excerpt), swap the row's label for a snippet centred on the
    // first hit so the user can see why the row matched. The label
    // alone — usually the first line / heading — would read as an
    // unhelpful "row with no visible match" otherwise. Falls back to
    // the regular label when the query also hits the label (the
    // standard inline highlight already shows the user where).
    const labelHasMatch = q && node.label.toLowerCase().includes(q.toLowerCase());
    if (q && !labelHasMatch && node.excerpt) {
      const matches = findContentMatches(node.excerpt, q, 1);
      if (matches.length > 0) {
        labelSpan.appendChild(buildSnippet(node.excerpt, matches[0].start, q.length, muted, searchHlBg));
      } else {
        labelSpan.appendChild(renderLabelInline(node.label, flagColors, q, searchHlBg));
      }
    } else {
      labelSpan.appendChild(renderLabelInline(node.label, flagColors, q, searchHlBg));
    }
    row.appendChild(labelSpan);
    // Fall-back: clicks on the row that didn't land on the label span
    // (icon, padding) still pan. Without this the pin button + flow
    // arrow + drag-area icon swallow part of the row, so clicks there
    // appear to do nothing.
    row.addEventListener("click", (ev) => {
      const tgt = ev.target as HTMLElement | null;
      if (tgt && tgt.closest("[data-shelf-row-label]")) return; // already handled
      if (tgt && tgt.closest("button")) return; // pin / collapse handled separately
      state.focusShape(node.shapeId, undefined, isOpen ? panel.offsetWidth : 0);
    });
    const pinBtn = h("button", { title: isPinned ? "Unpin" : "Pin", style: { border: "none", background: "none", cursor: "pointer", padding: "0", opacity: isPinned ? "0.8" : "0.4", color: isPinned ? theme.accent : muted, display: "flex", alignItems: "center", width: "16px", height: "16px" }, onClick: () => { if (isPinned) pinned.delete(node.id); else pinned.add(node.id); rebuildBody(); } });
    pinBtn.appendChild(icon("pin", 12));
    row.appendChild(pinBtn);
    return row;
  }

  // Expose width accessors for the resizer companion. The resizer mutates
  // openWidth without re-running rebuild() so the user gets a smooth drag.
  (panel as ShelfPanelEl).__setShelfWidth = (w: number) => {
    openWidth = w;
    if (isOpen) { panel.style.width = `${w}px`; panel.style.minWidth = `${w}px`; }
  };
  (panel as ShelfPanelEl).__getShelfWidth = () => openWidth;
  (panel as ShelfPanelEl).__isShelfOpen = () => isOpen;
  // Quick-find (Cmd+F) in a notebook routes here instead of the doc find
  // bar: open the shelf if needed and drop the caret into the search box.
  (panel as ShelfPanelEl).__openAndFocusSearch = () => {
    if (!isOpen) { isOpen = true; rebuild(); }
    searchInput.focus();
    searchInput.select();
  };

  state.addEventListener("change", rebuild);
  rebuild();
  return panel;
}

export interface ShelfPanelEl extends HTMLElement {
  __setShelfWidth?: (w: number) => void;
  __getShelfWidth?: () => number;
  __isShelfOpen?: () => boolean;
  __openAndFocusSearch?: () => void;
}
