/**
 * Desktop file view — the desk as a traditional desktop.
 *
 * Top-level items sit on a grid of icons you can drag anywhere. Folders
 * look like folders, and opening one does not raise a window: its
 * contents bloom into a ring around it, connected by hairlines, and a
 * folder inside that ring blooms into its own arc facing outward. The
 * whole thing is one canvas — pan by dragging the surface, ⌘-wheel or
 * pinch to zoom.
 *
 * Gestures follow the list panel where the list panel has an opinion: a
 * single tap opens a file or a project (the same click the tree takes),
 * and the double tap — which only containers answer — rings them.
 */

import { createSurface, rgba, mix, clampAxis } from "./file-view-surface.js";
import { drawIcon, drawLabel } from "./file-view-icons.js";
import {
  rootNodes, childrenOf, isContainer, kindOf, leafCount, isItemActive, openNode, tintOf,
} from "./file-view-data.js";
import { getFileViewLayout, saveFileViewLayout } from "./file-view-mode.js";

const ICON_W = 44, ICON_H = 36;
const CELL_W = 76, CELL_H = 72, GAP = 8;
const MARGIN = 14;
const RING_MIN = 92;
const MAX_DEPTH = 6;
const MAX_NODES = 1200;

export function createDesktopFileView(container, state, hidePanel) {
  const saved = getFileViewLayout(state);
  const positions = saved.positions;
  const openIds = new Set(saved.openIds);
  let selectedId = null;
  let hoverId = null;
  let placed = [];
  let framed = false;      // camera parked on the content once
  let saveTimer = 0;
  // `createSurface` fires its first resize before it has returned, so
  // nothing may touch `surface` until the constructor hands it back.
  let ready = false;

  const surface = createSurface(container, {
    hitTest, idOf: (p) => p.node.id, onDraw: draw, onTap, onHover,
    canDrag: (p) => p.depth === 0,
    onDrag: onDragItem, onDragEnd: () => schedulePersist(),
    deferSingleTap: (p) => !!p && p.node.type === "project",
    onKey, clampCamera,
    onCameraChange: () => { if (hoverId) { hoverId = null; surface.canvas.style.cursor = "default"; } },
    onResize: () => { if (ready) relayout(); },
  });

  // ===== layout =====

  function place(node, cx, cy, depth, parent) {
    placed.push({ node, cx, cy, depth, parent, open: openIds.has(node.id) });
  }

  function layoutRing(node, cx, cy, baseAngle, spread, depth) {
    if (depth > MAX_DEPTH || placed.length > MAX_NODES) return;
    const kids = childrenOf(node);
    const n = kids.length;
    if (!n) return;
    const full = spread >= Math.PI * 2 - 1e-6;
    const arc = full ? Math.PI * 2 : spread;
    const radius = Math.max(RING_MIN, (n * CELL_W * 0.95) / arc);
    for (let i = 0; i < n; i++) {
      const a = full
        ? baseAngle + (i * Math.PI * 2) / n
        : baseAngle - spread / 2 + spread * (n === 1 ? 0.5 : i / (n - 1));
      const kx = cx + Math.cos(a) * radius;
      const ky = cy + Math.sin(a) * radius;
      place(kids[i], kx, ky, depth, { cx, cy });
      if (openIds.has(kids[i].id)) {
        // A ringed folder blooms into the sector it already occupies,
        // aimed outward — the radial-tree rule that keeps a nested ring
        // from folding back over its own parent.
        const sector = arc / n;
        layoutRing(kids[i], kx, ky, a, Math.min(Math.PI * 0.9, Math.max(0.7, sector * 0.85)), depth + 1);
      }
    }
  }

  function relayout() {
    placed = [];
    const roots = rootNodes(state);
    const viewW = surface.size.width || 300;
    const cols = Math.max(1, Math.floor((viewW - MARGIN * 2 + GAP) / (CELL_W + GAP)));
    roots.forEach((node, slot) => {
      // The grid slot follows the node's place in the tree, not how many
      // neighbours happen to be auto-placed — otherwise dragging one icon
      // shuffles every icon after it up a slot.
      const manual = positions[node.id];
      const cx = manual ? manual.x : MARGIN + CELL_W / 2 + (slot % cols) * (CELL_W + GAP);
      const cy = manual ? manual.y : MARGIN + CELL_H / 2 + Math.floor(slot / cols) * (CELL_H + GAP);
      place(node, cx, cy, 0, null);
      if (openIds.has(node.id)) layoutRing(node, cx, cy, -Math.PI / 2, Math.PI * 2, 1);
    });
    frameContent();
    surface.requestDraw();
  }

  /** Park the camera on the grid the first time there is anything to
   *  look at — top-anchored, horizontally centred, like a desktop. */
  function frameContent() {
    if (framed || !placed.length || !surface.size.height) return;
    framed = true;
    const viewW = surface.size.width, viewH = surface.size.height;
    const cols = Math.max(1, Math.floor((viewW - MARGIN * 2 + GAP) / (CELL_W + GAP)));
    const rowsW = MARGIN * 2 + cols * (CELL_W + GAP) - GAP;
    surface.camera.x = rowsW / 2;
    surface.camera.y = viewH / 2 - MARGIN;
  }

  /** Keep the icons reachable: a pan or a zoom-out may push the desk
   *  around, but never off the edge of what is drawn. */
  function clampCamera(cam, size) {
    if (!placed.length) return;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const p of placed) {
      const r = cellRect(p);
      minX = Math.min(minX, r.x); maxX = Math.max(maxX, r.x + r.w);
      minY = Math.min(minY, r.y); maxY = Math.max(maxY, r.y + r.h);
    }
    cam.x = clampAxis(cam.x, minX, maxX, size.width / (2 * cam.zoom));
    cam.y = clampAxis(cam.y, minY, maxY, size.height / (2 * cam.zoom));
  }

  // ===== drawing =====

  function cellRect(p) {
    return {
      x: p.cx - CELL_W / 2, y: p.cy - ICON_H / 2 - 6,
      w: CELL_W, h: CELL_H,
    };
  }

  function draw(ctx, ui) {
    const c = ui.colors;
    ctx.fillStyle = rgba(c.bg, 1);
    ctx.fillRect(0, 0, ui.width, ui.height);
    drawSurfaceGrid(ctx, ui);
    if (!placed.length) {
      ctx.save();
      ctx.fillStyle = rgba(c.fg, 0.4);
      ctx.textAlign = "center";
      ctx.font = "12px system-ui, sans-serif";
      ctx.fillText("This desk is empty", ui.width / 2, ui.height / 2);
      ctx.restore();
      return;
    }

    // Anything a bloom didn't come from stays where it is but drops
    // behind a scrim: opening a folder brings its contents forward
    // rather than raising a window over them, and without the scrim the
    // ring lands unreadably on top of its own neighbours.
    const front = placed.filter((p) => p.depth > 0 || p.open);
    const back = placed.filter((p) => !(p.depth > 0 || p.open));
    for (const p of back) drawNode(ctx, ui, p);
    if (front.length) {
      ctx.fillStyle = rgba(c.bg, 0.72);
      ctx.fillRect(0, 0, ui.width, ui.height);
    }

    // Hairlines from an open folder to each of its ringed children,
    // painted under the icons so an icon always wins the pixel.
    ctx.save();
    ctx.strokeStyle = rgba(c.fg, 0.22);
    ctx.lineWidth = 1;
    for (const p of placed) {
      if (!p.parent) continue;
      const a = surface.worldToScreen(p.parent.cx, p.parent.cy);
      const b = surface.worldToScreen(p.cx, p.cy);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
    ctx.restore();

    // Shallow rings under deep ones, so a nested bloom reads as being
    // in front of the one it grew out of.
    front.sort((a, b) => a.depth - b.depth);
    for (const p of front) drawNode(ctx, ui, p);
  }

  function drawSurfaceGrid(ctx, ui) {
    const step = 26 * surface.camera.zoom;
    if (step < 12) return;
    const c = ui.colors;
    const origin = surface.worldToScreen(0, 0);
    const startX = origin.x % step, startY = origin.y % step;
    ctx.save();
    ctx.fillStyle = rgba(c.fg, 0.055);
    for (let x = startX; x < ui.width; x += step) {
      for (let y = startY; y < ui.height; y += step) ctx.fillRect(x, y, 1, 1);
    }
    ctx.restore();
  }

  function drawNode(ctx, ui, p) {
    const z = surface.camera.zoom;
    const s = surface.worldToScreen(p.cx, p.cy);
    const w = ICON_W * z, hgt = ICON_H * z;
    const x = s.x - w / 2, y = s.y - hgt / 2;
    if (x > ui.width + 60 || y > ui.height + 60 || x + w < -60 || y + hgt < -60) return;
    const item = p.node;
    const active = isItemActive(item, state);
    const opts = {
      active, open: p.open,
      selected: selectedId === item.id,
      hover: hoverId === item.id,
      flagged: !!item.flagged,
      tint: tintOf(item),
    };
    drawIcon(ctx, kindOf(item), x, y, w, hgt, ui.colors, opts);
    if (z > 0.5) {
      drawLabel(ctx, item.name, s.x, y + hgt + 6 * z, CELL_W * z - 6, ui.colors,
        { active, size: Math.max(8, 10.5 * Math.min(z, 1.4)), plate: p.depth > 0 || p.open });
    }
    // A closed container says how much it is holding, so the ring is
    // worth opening (or not) before you open it.
    if (isContainer(item) && !p.open && z > 0.65) {
      const n = leafCount(item);
      if (n > 0) {
        ctx.save();
        ctx.font = `${Math.max(8, 8.5 * z)}px system-ui, sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        const r = Math.max(6, 7 * z);
        const bx = x + w - r * 0.4, by = y + r * 0.4;
        ctx.beginPath();
        ctx.arc(bx, by, r, 0, Math.PI * 2);
        ctx.fillStyle = rgba(mix(ui.colors.bg, ui.colors.fg, 0.28), 1);
        ctx.fill();
        ctx.fillStyle = rgba(ui.colors.bg, 1);
        ctx.fillText(n > 99 ? "99+" : String(n), bx, by + 0.5);
        ctx.restore();
      }
    }
  }

  // ===== interaction =====

  function hitTest(world) {
    for (let i = placed.length - 1; i >= 0; i--) {
      const r = cellRect(placed[i]);
      if (world.x >= r.x && world.x <= r.x + r.w && world.y >= r.y && world.y <= r.y + r.h) {
        return placed[i];
      }
    }
    return null;
  }

  function onHover(p) {
    const id = p ? p.node.id : null;
    if (id === hoverId) return;
    hoverId = id;
    surface.canvas.style.cursor = p ? "pointer" : "default";
    surface.requestDraw();
  }

  /** Every id in `item`'s currently-bloomed subtree, `item` included. */
  function subtreeIds(item, out = new Set()) {
    out.add(item.id);
    if (openIds.has(item.id)) for (const kid of childrenOf(item)) subtreeIds(kid, out);
    return out;
  }

  /** The desk-level node a bloom grew out of, so opening something deep
   *  in a chain frames the whole chain rather than orphaning it. */
  function bloomRoot(item) {
    const holds = (node) => node.id === item.id || childrenOf(node).some(holds);
    return rootNodes(state).find(holds) || item;
  }

  /** Bring a freshly opened bloom into view — centred, and zoomed out
   *  far enough to hold it when the ring is wider than the panel. */
  function focusBloom(item) {
    const ids = subtreeIds(bloomRoot(item));
    const own = placed.filter((p) => ids.has(p.node.id));
    if (!own.length || !surface.size.width) return;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const p of own) {
      const r = cellRect(p);
      minX = Math.min(minX, r.x); maxX = Math.max(maxX, r.x + r.w);
      minY = Math.min(minY, r.y); maxY = Math.max(maxY, r.y + r.h);
    }
    surface.camera.x = (minX + maxX) / 2;
    surface.camera.y = (minY + maxY) / 2;
    const fit = Math.min(
      surface.size.width / Math.max(1, maxX - minX + 16),
      surface.size.height / Math.max(1, maxY - minY + 16));
    if (fit < surface.camera.zoom) surface.camera.zoom = Math.max(0.35, fit);
  }

  function toggleOpen(item) {
    if (openIds.has(item.id)) {
      // Closing a folder closes everything that bloomed out of it —
      // otherwise reopening it snaps a whole buried tree back at once.
      const drop = (node) => {
        openIds.delete(node.id);
        for (const kid of childrenOf(node)) drop(kid);
      };
      drop(item);
    } else {
      openIds.add(item.id);
      relayout();
      focusBloom(item);
      surface.requestDraw();
      schedulePersist();
      return;
    }
    relayout();
    schedulePersist();
  }

  function onTap(p, world, { double }) {
    if (!p) { selectedId = null; surface.requestDraw(); return; }
    const item = p.node;
    selectedId = item.id;
    if (double) {
      if (isContainer(item)) toggleOpen(item);
      return;
    }
    if (isContainer(item) && item.type !== "project") return;
    openNode(state, item, hidePanel);
  }

  function onDragItem(p, world, delta) {
    const cur = positions[p.node.id] || { x: p.cx, y: p.cy };
    positions[p.node.id] = { x: cur.x + delta.dx, y: cur.y + delta.dy };
    relayout();
  }

  function onKey(e) {
    if (e.key === "Escape" && (openIds.size || selectedId)) {
      openIds.clear();
      selectedId = null;
      relayout();
      schedulePersist();
      return true;
    }
    return false;
  }

  // ===== persistence =====

  function schedulePersist() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(persist, 400);
  }

  function persist() {
    saveTimer = 0;
    // Drop anything the tree no longer has, so a desk's arrangement
    // can't grow a record per file ever deleted from it.
    const live = new Set();
    const walk = (nodes) => nodes.forEach((n) => { live.add(n.id); walk(childrenOf(n)); });
    walk(rootNodes(state));
    const prunedPositions = {};
    for (const [id, pos] of Object.entries(positions)) if (live.has(id)) prunedPositions[id] = pos;
    saveFileViewLayout(state, {
      positions: prunedPositions,
      openIds: [...openIds].filter((id) => live.has(id)),
    }).catch(() => {});
  }

  ready = true;
  relayout();

  return {
    refresh() { relayout(); },
    repaint() { surface.refreshColors(); },
    destroy() {
      if (saveTimer) { clearTimeout(saveTimer); persist(); }
      surface.destroy();
    },
    chrome: surface.chrome,
  };
}
