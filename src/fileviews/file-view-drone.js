/**
 * Drone view — the desk seen from a drone hovering over it.
 *
 * `file-view-drone-layout.js` turns the tree into a floor plan; this
 * module flies over it. The projection is axonometric rather than
 * perspective (parallel lines stay parallel, so a plot reads as the same
 * plot wherever it sits) with a fixed high pitch and a yaw the compass
 * in the corner turns. No WebGL and no 3D dependency: four corners per
 * box, back-face culling by projected winding, painter's order by how
 * far forward a box reaches.
 *
 * Reading it: area is mass — how much a folder holds. Elevation is
 * containment — a plot stands on the plot that contains it. Height is
 * the file's own size, and a roof brightens the more recently the file
 * was edited. Tap a building to open it, tap a plot's name (or
 * double-tap the plot itself) to fly down into it, and the breadcrumb
 * above the canvas flies back out.
 */

import { createSurface, rgba, mix, toRgb, uiFont, clampAxis } from "./file-view-surface.js";
import {
  rootNodes, childrenOf, isContainer, kindOf, isItemActive, openNode, tintOf,
} from "./file-view-data.js";
import { buildModel, recencyOf, PLATE, PLATE_THICK } from "./file-view-drone-layout.js";

// How far the camera is tipped off vertical: 1 is straight down (a
// plan), 0 is at eye level. High enough to read as a map, low enough
// that a building has walls — and the higher it is, the more of a tall
// narrow sidebar the model can fill.
const PITCH = 0.7;
const ZK = 0.9;            // screen rise per unit of height
const DEFAULT_YAW = -Math.PI / 5;
const COMPASS_R = 21;
const COMPASS_INSET = 30;

export function createDroneFileView(container, state, hidePanel) {
  let yaw = DEFAULT_YAW;
  let model = [];
  let painted = [];          // draw order — hit-tested back to front
  let labelHits = [];        // district name plates, in screen space
  let focusPath = [];        // ids of the plots flown into, outermost first
  let selectedId = null;
  let hoverBox = null;
  let hoverPt = null;
  let framed = false;
  let ready = false;
  let modelMaxZ = 0;

  const surface = createSurface(container, {
    hitTest, idOf: (b) => (b && b.compass ? "compass" : b?.node?.id || null),
    onDraw: draw, onTap, onHover,
    deferSingleTap: (b) => !!b && !b.compass && b.node?.type === "project",
    canDrag: (b) => !!b && !!b.compass,
    onDrag: onDragCompass,
    onKey, clampCamera,
    onCameraChange: () => { hoverBox = null; hoverPt = null; },
    onResize: () => { if (ready) frameContent(); },
  });

  const breadcrumb = document.createElement("div");
  breadcrumb.className = "file-view-breadcrumb";
  surface.chrome.appendChild(breadcrumb);

  // ===== projection =====

  const proj = (x, y, z) => {
    const c = Math.cos(yaw), s = Math.sin(yaw);
    const rx = x * c - y * s;
    const ry = x * s + y * c;
    return { x: rx, y: ry * PITCH - z * ZK };
  };
  const toScreen = (x, y, z) => {
    const p = proj(x, y, z);
    return surface.worldToScreen(p.x, p.y);
  };

  // ===== model =====

  /** The node the view is currently standing on, or null at the top. */
  function focusNode() {
    let nodes = rootNodes(state);
    let node = null;
    for (const id of focusPath) {
      const next = nodes.find((n) => n.id === id);
      if (!next) break;
      node = next;
      nodes = childrenOf(next);
    }
    return node;
  }

  function rebuild() {
    // Whatever the pointer was over belongs to the level we just left.
    hoverBox = null;
    hoverPt = null;
    const node = focusNode();
    const roots = node ? childrenOf(node) : rootNodes(state);
    model = buildModel(state, roots);
    modelMaxZ = 0;
    const tallest = (boxes) => boxes.forEach((b) => { modelMaxZ = Math.max(modelMaxZ, b.z1); tallest(b.children); });
    tallest(model);
    renderBreadcrumb();
    frameContent();
    surface.requestDraw();
  }

  /** Fit the plate to the panel. Runs once per focus level: a refresh
   *  after a file changed must not throw away where the user flew to.
   *
   *  The fit is against the plate's *projected* span, not its plan size:
   *  a square turned 36° is half as wide again on screen, which is what
   *  pushed the model off both edges of the panel. Worst case over every
   *  yaw is the diagonal, so the model stays inside the panel however
   *  far the compass is turned. */
  function fitZoom() {
    if (!surface.size.width) return 1;
    const spanX = PLATE * Math.SQRT2;
    const spanY = PLATE * Math.SQRT2 * PITCH + modelMaxZ * ZK;
    const fit = Math.min(surface.size.width / spanX, surface.size.height / spanY) * 0.94;
    return Math.max(0.35, Math.min(1.6, fit));
  }

  function frameContent() {
    if (framed || !surface.size.width) return;
    framed = true;
    surface.camera.x = 0;
    // The plate's middle is the model's *floor*; its mass stands above.
    surface.camera.y = -(modelMaxZ * ZK) / 2;
    surface.camera.zoom = fitZoom();
  }

  function renderBreadcrumb() {
    breadcrumb.innerHTML = "";
    const deskName = state.getActiveDesk?.()?.name || "Desk";
    const crumbs = [{ id: null, name: deskName }];
    let nodes = rootNodes(state);
    for (const id of focusPath) {
      const n = nodes.find((x) => x.id === id);
      if (!n) break;
      crumbs.push({ id, name: n.name });
      nodes = childrenOf(n);
    }
    if (crumbs.length === 1) { breadcrumb.hidden = true; return; }
    breadcrumb.hidden = false;
    crumbs.forEach((crumb, i) => {
      if (i) {
        const sep = document.createElement("span");
        sep.className = "file-view-crumb-sep";
        sep.textContent = "›";
        breadcrumb.appendChild(sep);
      }
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "file-view-crumb";
      btn.textContent = crumb.name;
      if (i === crumbs.length - 1) btn.classList.add("current");
      btn.addEventListener("click", () => {
        focusPath = focusPath.slice(0, i);
        framed = false;
        rebuild();
      });
      breadcrumb.appendChild(btn);
    });
  }

  /** Bound the flight to the model: the plate's own projected extent at
   *  the yaw currently in force, so turning the compass never leaves the
   *  camera pointed at empty sky. */
  function clampCamera(cam, size) {
    // There is nothing outside the plate, so zooming out past "the whole
    // plate fits" only buys empty sky.
    cam.zoom = Math.max(cam.zoom, fitZoom());
    const h2 = PLATE / 2 + 4;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const x of [-h2, h2]) {
      for (const y of [-h2, h2]) {
        for (const z of [-PLATE_THICK, modelMaxZ]) {
          const p = proj(x, y, z);
          minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
          minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
        }
      }
    }
    cam.x = clampAxis(cam.x, minX, maxX, size.width / (2 * cam.zoom));
    cam.y = clampAxis(cam.y, minY, maxY, size.height / (2 * cam.zoom));
  }

  // ===== drawing =====

  const shade = (c, k) => mix(c, { r: 0, g: 0, b: 0 }, k);

  function faceColor(box, colors) {
    // A tinted node is the one place the model takes a hue from outside
    // the theme: the colour the user gave the row in the list.
    const tint = tintOf(box.node);
    if (tint) {
      const t = toRgb(tint, null);
      if (t) return mix(colors.bg, t, box.container ? 0.42 : 0.62);
    }
    if (box.container) {
      const t = 0.10 + Math.min(0.22, box.depth * 0.05);
      return mix(colors.bg, colors.fg, t);
    }
    if (isItemActive(box.node, state)) return colors.link;
    const rec = recencyOf(state, box.node);
    const kind = kindOf(box.node);
    // A little type separation on top of the recency ramp — enough to
    // tell a notebook block from a document block from above.
    const bias = kind === "notebook" || kind === "gutter" ? 0.06
      : kind === "pdf" ? -0.05 : kind === "stack" ? 0.02 : 0;
    return mix(colors.bg, colors.fg, Math.max(0.14, Math.min(0.78, 0.24 + rec * 0.42 + bias)));
  }

  /** Draw one box. Sides are culled by projected winding, so the two the
   *  camera can see fall out of the yaw rather than being special-cased. */
  function paintBox(ctx, box, colors, opts = {}) {
    const { x0, y0, x1, y1, z0, z1 } = box;
    const top = [
      toScreen(x0, y0, z1), toScreen(x1, y0, z1),
      toScreen(x1, y1, z1), toScreen(x0, y1, z1),
    ];
    const base = [
      toScreen(x0, y0, z0), toScreen(x1, y0, z0),
      toScreen(x1, y1, z0), toScreen(x0, y1, z0),
    ];
    // A box that lands off-canvas, or that projects to a couple of
    // pixels, is not worth the eight projections and three fills — and
    // nothing inside it can be worth them either.
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const p of [...top, ...base]) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
    const M = 300;
    if (maxX < -M || minX > surface.size.width + M
      || maxY < -M || minY > surface.size.height + M) return false;
    if (maxX - minX < 2 && maxY - minY < 2) return false;

    const col = opts.color || faceColor(box, colors);
    const line = rgba(colors.dark ? shade(col, 0.55) : mix(col, colors.fg, 0.35), 0.9);
    ctx.lineWidth = 1;
    ctx.lineJoin = "round";
    for (let i = 0; i < 4; i++) {
      const j = (i + 1) % 4;
      const quad = [top[i], top[j], base[j], base[i]];
      // Screen y grows downward, so a wall the camera can see winds
      // counter-clockwise (negative area) while the one behind it winds
      // the other way. Cull the positive ones.
      if (signedArea(quad) >= 0) continue;
      ctx.beginPath();
      ctx.moveTo(quad[0].x, quad[0].y);
      for (let k = 1; k < 4; k++) ctx.lineTo(quad[k].x, quad[k].y);
      ctx.closePath();
      ctx.fillStyle = rgba(shade(col, i % 2 ? 0.34 : 0.19), 1);
      ctx.fill();
      ctx.strokeStyle = line;
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.moveTo(top[0].x, top[0].y);
    for (let k = 1; k < 4; k++) ctx.lineTo(top[k].x, top[k].y);
    ctx.closePath();
    ctx.fillStyle = rgba(col, 1);
    ctx.fill();
    ctx.strokeStyle = opts.highlight ? rgba(colors.link, 0.95) : line;
    ctx.lineWidth = opts.highlight ? 1.6 : 1;
    ctx.stroke();
    box._top = top;
    box._sides = base;
    return true;
  }

  const signedArea = (p) => {
    let a = 0;
    for (let i = 0; i < p.length; i++) {
      const q = p[(i + 1) % p.length];
      a += p[i].x * q.y - q.x * p[i].y;
    }
    return a / 2;
  };

  /** How far forward a box reaches — the painter's key. */
  function frontKey(box) {
    const c = Math.cos(yaw), s = Math.sin(yaw);
    let m = -Infinity;
    for (const [x, y] of [[box.x0, box.y0], [box.x1, box.y0], [box.x1, box.y1], [box.x0, box.y1]]) {
      m = Math.max(m, x * s + y * c);
    }
    return m;
  }

  function paintLevel(ctx, boxes, colors) {
    const order = [...boxes].sort((a, b) => frontKey(a) - frontKey(b));
    for (const box of order) {
      const active = isItemActive(box.node, state);
      const drawn = paintBox(ctx, box, colors, {
        highlight: selectedId === box.node.id || hoverBox?.node === box.node || active,
      });
      if (!drawn) { box._top = null; continue; }
      painted.push(box);
      if (box.children.length) paintLevel(ctx, box.children, colors);
    }
  }

  function draw(ctx, ui) {
    const c = ui.colors;
    painted = [];
    labelHits = [];
    ctx.fillStyle = rgba(c.bg, 1);
    ctx.fillRect(0, 0, ui.width, ui.height);

    // The ground plate everything stands on.
    paintBox(ctx, {
      x0: -PLATE / 2 - 4, y0: -PLATE / 2 - 4, x1: PLATE / 2 + 4, y1: PLATE / 2 + 4,
      z0: -PLATE_THICK, z1: 0, container: true, depth: -1, children: [],
      node: { id: "__plate__", name: "" },
    }, c, { color: mix(c.bg, c.fg, 0.06) });

    if (!model.length) {
      ctx.save();
      ctx.fillStyle = rgba(c.fg, 0.4);
      ctx.textAlign = "center";
      ctx.font = uiFont(12);
      ctx.fillText("Nothing here", ui.width / 2, ui.height / 2);
      ctx.restore();
    } else {
      paintLevel(ctx, model, c);
      paintDistrictLabels(ctx, c, model);
    }
    paintHoverLabel(ctx, c);
    paintCompass(ctx, ui);
  }

  /** District names — the plots at this focus level, labelled over the
   *  model rather than on it. A plot is nearly covered by what stands on
   *  it (that is what a plot is for), so a name painted on the slab is a
   *  name nobody ever sees. Deeper plots are named on hover instead. */
  function paintDistrictLabels(ctx, colors, boxes) {
    for (const box of boxes) {
      if (!box.container || !box._top) continue;
      const rect = paintPlotLabel(ctx, box, colors);
      // The name is also the way in. A plot is covered by what stands on
      // it, so its slab has almost no clickable area of its own — the
      // label is the affordance that does, and one tap flies down into
      // it the way the breadcrumb flies back out.
      if (rect) labelHits.push({ box, rect });
    }
  }

  /** A plot's name, sized to the plot and dropped when it won't fit. */
  function paintPlotLabel(ctx, box, colors) {
    const a = toScreen(box.x0, box.y0, box.z1);
    const b = toScreen(box.x1, box.y0, box.z1);
    const c = toScreen(box.x1, box.y1, box.z1);
    const d = toScreen(box.x0, box.y1, box.z1);
    const wide = Math.hypot(b.x - a.x, b.y - a.y);
    const deep = Math.hypot(d.x - a.x, d.y - a.y);
    if (Math.min(wide, deep * 1.6) < 34) return null;
    const cx = (a.x + b.x + c.x + d.x) / 4;
    const cy = (a.y + b.y + c.y + d.y) / 4;
    const size = Math.max(8, Math.min(12, Math.min(wide, deep * 1.6) / 6));
    ctx.save();
    ctx.font = uiFont(size, 500);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const full = box.node.name || "";
    let text = full;
    while (text.length > 2 && ctx.measureText(text).width > wide * 0.86) text = text.slice(0, -1);
    if (text !== full) text += "…";
    const tw = ctx.measureText(text).width;
    const rect = { x: cx - tw / 2 - 5, y: cy - size, w: tw + 10, h: size * 2 };
    const hot = hoverBox === box;
    ctx.fillStyle = rgba(colors.bg, hot ? 0.85 : 0.62);
    ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
    if (hot) {
      ctx.strokeStyle = rgba(colors.link, 0.8);
      ctx.lineWidth = 1;
      ctx.strokeRect(rect.x + 0.5, rect.y + 0.5, rect.w - 1, rect.h - 1);
    }
    ctx.fillStyle = rgba(colors.fg, hot ? 1 : 0.85);
    ctx.fillText(text, cx, cy);
    ctx.restore();
    return rect;
  }

  function paintHoverLabel(ctx, colors) {
    const box = hoverBox;
    if (!box || !hoverPt) return;
    // A plot that already carries a district name doesn't need a second
    // copy of it following the cursor.
    if (labelHits.some((l) => l.box === box)) return;
    const text = box.node.name || "";
    ctx.save();
    ctx.font = uiFont(11, 500);
    const w = ctx.measureText(text).width;
    const x = Math.min(Math.max(8, hoverPt.x - w / 2 - 6), surface.size.width - w - 20);
    const y = Math.max(6, hoverPt.y - 30);
    ctx.fillStyle = rgba(mix(colors.bg, colors.fg, 0.16), 0.97);
    ctx.strokeStyle = rgba(colors.fg, 0.18);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.rect(x, y, w + 12, 20);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = rgba(colors.fg, 0.95);
    ctx.textBaseline = "middle";
    ctx.fillText(text, x + 6, y + 10.5);
    ctx.restore();
  }

  function compassCentre() {
    return {
      x: surface.size.width - COMPASS_INSET,
      y: surface.size.height - COMPASS_INSET,
    };
  }

  function paintCompass(ctx, ui) {
    const c = ui.colors;
    const o = compassCentre();
    ctx.save();
    ctx.beginPath();
    ctx.arc(o.x, o.y, COMPASS_R, 0, Math.PI * 2);
    ctx.fillStyle = rgba(mix(c.bg, c.fg, 0.10), 0.9);
    ctx.fill();
    ctx.strokeStyle = rgba(c.fg, 0.22);
    ctx.lineWidth = 1;
    ctx.stroke();
    // North needle, turned by the yaw the model is drawn at.
    const a = -Math.PI / 2 - yaw;
    ctx.beginPath();
    ctx.moveTo(o.x + Math.cos(a) * (COMPASS_R - 5), o.y + Math.sin(a) * (COMPASS_R - 5));
    ctx.lineTo(o.x + Math.cos(a + 2.5) * 6, o.y + Math.sin(a + 2.5) * 6);
    ctx.lineTo(o.x + Math.cos(a - 2.5) * 6, o.y + Math.sin(a - 2.5) * 6);
    ctx.closePath();
    ctx.fillStyle = rgba(c.link, 0.9);
    ctx.fill();
    ctx.restore();
  }

  // ===== interaction =====

  const pointInPoly = (pt, poly) => {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const a = poly[i], b = poly[j];
      if ((a.y > pt.y) !== (b.y > pt.y)
        && pt.x < ((b.x - a.x) * (pt.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
    }
    return inside;
  };

  function hitTest(world, screen) {
    const o = compassCentre();
    if (Math.hypot(screen.x - o.x, screen.y - o.y) <= COMPASS_R) return { compass: true };
    for (const { box, rect } of labelHits) {
      if (screen.x >= rect.x && screen.x <= rect.x + rect.w
        && screen.y >= rect.y && screen.y <= rect.y + rect.h) return box;
    }
    for (let i = painted.length - 1; i >= 0; i--) {
      const box = painted[i];
      if (!box._top || box.node.id === "__plate__") continue;
      if (pointInPoly(screen, box._top)) return box;
      // The two visible walls, so a tall building is grabbable by its side.
      for (let k = 0; k < 4; k++) {
        const j = (k + 1) % 4;
        const quad = [box._top[k], box._top[j], box._sides[j], box._sides[k]];
        if (signedArea(quad) < 0 && pointInPoly(screen, quad)) return box;
      }
    }
    return null;
  }

  function onHover(box, world, e) {
    const next = box && !box.compass ? box : null;
    surface.canvas.style.cursor = box ? "pointer" : "default";
    // Only a *change* of what is under the pointer costs a frame: the
    // model is hundreds of filled polygons, and repainting it on every
    // mousemove would make hovering the most expensive thing the sidebar
    // does. The label anchors where the hover began.
    if ((next?.node?.id || null) === (hoverBox?.node?.id || null)) return;
    hoverBox = next;
    if (next && e) {
      const r = surface.canvas.getBoundingClientRect();
      hoverPt = { x: e.clientX - r.left, y: e.clientY - r.top };
    } else {
      hoverPt = null;
    }
    surface.requestDraw();
  }

  function onTap(box, world, { double }) {
    if (box && box.compass) {
      if (double) { yaw = DEFAULT_YAW; surface.requestDraw(); }
      return;
    }
    if (!box) { selectedId = null; surface.requestDraw(); return; }
    const item = box.node;
    selectedId = item.id;
    const canDescend = isContainer(item) && childrenOf(item).length > 0;
    // A tap on a district name flies in on its own — it is a labelled
    // control, not a piece of the model. Everything else takes the same
    // double-tap the desktop view uses.
    if (canDescend && (double || labelHits.some((l) => l.box === box))) {
      const path = pathTo(item.id);
      if (path) { focusPath = path; framed = false; rebuild(); }
      return;
    }
    if (isContainer(item) && item.type !== "project") return;
    openNode(state, item, hidePanel);
  }

  /** The focus path that lands on `id`, searched from the current focus
   *  outward — the box tree is only ever one level of nesting deep in
   *  node terms, so this walks the same nodes `rebuild` laid out. */
  function pathTo(id) {
    const base = focusNode() ? [...focusPath] : [];
    const walk = (nodes, trail) => {
      for (const n of nodes) {
        if (n.id === id) return [...trail, n.id];
        const found = walk(childrenOf(n), [...trail, n.id]);
        if (found) return found;
      }
      return null;
    };
    const start = focusNode() ? childrenOf(focusNode()) : rootNodes(state);
    return walk(start, base);
  }

  function onDragCompass(handle, world, delta) {
    const e = delta.event;
    if (!e) return;
    const r = surface.canvas.getBoundingClientRect();
    const o = compassCentre();
    yaw = -(Math.atan2(e.clientY - r.top - o.y, e.clientX - r.left - o.x) + Math.PI / 2);
    surface.settle();
    surface.requestDraw();
  }

  function onKey(e) {
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      yaw += (e.key === "ArrowLeft" ? -1 : 1) * Math.PI / 24;
      surface.settle();
      surface.requestDraw();
      return true;
    }
    if (e.key === "Escape" && focusPath.length) {
      focusPath = focusPath.slice(0, -1);
      framed = false;
      rebuild();
      return true;
    }
    return false;
  }

  ready = true;
  rebuild();

  return {
    refresh() {
      // A focus that no longer resolves (the folder was deleted or moved
      // out of the desk) falls back to the level that still does.
      while (focusPath.length && !focusNode()) focusPath = focusPath.slice(0, -1);
      rebuild();
    },
    repaint() { surface.refreshColors(); },
    destroy() { surface.destroy(); },
    chrome: surface.chrome,
  };
}
