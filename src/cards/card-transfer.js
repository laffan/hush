/**
 * Moving a card into — or out of — a file that is named rather than
 * pointed at: a sidebar row a card was dropped on, a card row dragged
 * out of the sidebar, Courier's CARDS notebook.
 *
 * Every write follows the panes' rule that **a surface holding a file
 * owns it** (README-TECHNICAL; courier-send.js does the same for its
 * appends): a document goes to the main editor if it shows it, else a
 * pane showing it, else the file on disk — and a document inside the
 * open project's buffer is flushed, written on disk and reopened. A
 * notebook goes to whichever live canvas has it (main, pane, stack
 * column), else to its file: the envelope is parsed, the one shape
 * added or taken out, and the rest passed through untouched — never
 * re-assembled from named fields (README-TECHNICAL, Notebooks).
 */

import { Transaction } from "@codemirror/state";
import { findNodeByFileId, isCardsHome } from "../state/tree-helpers.js";
import { getPanelWidthPx } from "../editor/modes.js";
import { liveNotebookCanvases } from "../pane/text-drag.js";
import { cardEdit } from "./card-facet.js";
import { findCards, serializeCard, cardSize, withoutPosition, CARD_HEADER_HEIGHT, CARD_DEFAULT_HEIGHT } from "./card-model.ts";
import { publishNotebookCards } from "./card-index.js";

// Read at call time: the module loads with the editor, before a test
// harness (or a late bridge) could have put the file store in place.
const hasFileStore = () => typeof window !== "undefined" && !!window.__TAURI_INTERNALS__;

async function invoke(cmd, args) {
  const { invoke: inv } = await import("@tauri-apps/api/core");
  return inv(cmd, args);
}

// ── Documents ────────────────────────────────────────────────────

function mainShowsDoc(state, fileId) {
  return state.editor?.view && state.currentFileId === fileId && !state.currentProjectId
    && !state.currentNotebookFileId && !state.currentPdfFileId && !state.currentStackFileId;
}

/** The live editor holding document `fileId`, if any. */
export async function liveDocView(state, fileId) {
  if (mainShowsDoc(state, fileId)) return state.editor.view;
  const { panes } = await import("../pane/pane-state.js");
  for (const [, pane] of panes) {
    if (pane?.fileId !== fileId || pane.fileType !== "document" || pane.localSync) continue;
    if (pane.editor?.view) return pane.editor.view;
  }
  return null;
}

/** Replace a view's text with `next` as one minimal change. */
function dispatchDiff(view, next, userEvent) {
  const cur = view.state.doc.toString();
  if (cur === next) return;
  let from = 0;
  const min = Math.min(cur.length, next.length);
  while (from < min && cur.charCodeAt(from) === next.charCodeAt(from)) from++;
  let a = cur.length, b = next.length;
  while (a > from && b > from && cur.charCodeAt(a - 1) === next.charCodeAt(b - 1)) { a--; b--; }
  view.dispatch({
    changes: { from, to: a, insert: next.slice(from, b) },
    annotations: [cardEdit.of(true), Transaction.userEvent.of(userEvent)],
  });
}

/**
 * Rewrite document `fileId` through `fn(text) → text | null` on whichever
 * copy is live. Returns false when `fn` declined (returned null).
 */
async function editDocument(state, fileId, fn, userEvent = "input.card") {
  const view = await liveDocView(state, fileId);
  if (view) {
    const next = fn(view.state.doc.toString());
    if (next == null) return false;
    dispatchDiff(view, next, userEvent);
    return true;
  }
  const inProject = state.currentProjectId && (state.projectDocIds || []).includes(fileId);
  if (inProject) await state.saveProjectContent();
  if (!hasFileStore()) throw new Error("No file store in this build");
  const file = await invoke("load_file", { id: fileId });
  const next = fn(file?.content || "");
  if (next == null) return false;
  await invoke("save_file", { id: fileId, content: next });
  const entry = state.files?.find((f) => f.id === fileId);
  if (entry && typeof entry.content === "string") entry.content = next;
  if (inProject) await state.openProject(state.currentProjectId);
  state.emit?.("doc-content-changed");
  return true;
}

/** The separator that puts a card on lines of its own after `text`. */
function separatorAfter(text) {
  if (!text) return "";
  if (text.endsWith("\n\n")) return "";
  return text.endsWith("\n") ? "\n" : "\n\n";
}

/** A card dropped on a document goes to its end. */
export async function appendCardToDocument(state, fileId, body, meta) {
  const card = serializeCard(body, withoutPosition(meta));
  await editDocument(state, fileId, (text) => text + separatorAfter(text) + card);
}

// ── Notebooks ────────────────────────────────────────────────────

/** The live canvas showing notebook `fileId`, if any. */
export function liveNotebook(fileId) {
  for (const entry of liveNotebookCanvases()) {
    if (entry.state?.hostFileId === fileId && entry.canvasEl?.isConnected) return entry;
  }
  return null;
}

/** The world point at the middle of what a canvas shows. */
export function viewCentreWorld(nbState) {
  const canvas = nbState.canvasEl;
  const c = nbState.visibleScreenCenter();
  const r = canvas ? canvas.getBoundingClientRect() : { left: 0, top: 0 };
  return screenToWorld(nbState.camera, c.x - r.left, c.y - r.top);
}

/** Canvas-local screen point → world, rotation included (the inverse of
 *  notebook/utils.ts#canvasToScreen). */
export function screenToWorld(cam, sx, sy) {
  const dx = sx - cam.x, dy = sy - cam.y;
  const rot = cam.rotation || 0;
  const cos = Math.cos(-rot), sin = Math.sin(-rot);
  return { x: (dx * cos - dy * sin) / cam.zoom, y: (dx * sin + dy * cos) / cam.zoom };
}

function parseEnvelope(content) {
  let env = null;
  try { env = content && content.trim() ? JSON.parse(content) : null; } catch { throw new Error("That notebook couldn't be read"); }
  if (Array.isArray(env)) return { format: "hushnote", version: 1, shapes: env };
  if (!env) return { format: "hushnote", version: 1, shapes: [] };
  if (!Array.isArray(env.shapes)) env.shapes = [];
  return env;
}

/** Edit a notebook that no canvas is showing, through its envelope. */
async function editNotebookOnDisk(fileId, fn) {
  const { parseLocalSentinel } = await import("../sync/local-sync.js");
  if (parseLocalSentinel(fileId)) throw new Error("Open that notebook to add cards to it");
  if (!hasFileStore()) throw new Error("No file store in this build");
  const file = await invoke("load_file", { id: fileId });
  const env = parseEnvelope(file?.content);
  if (fn(env) === false) return false;
  await invoke("save_file", { id: fileId, content: JSON.stringify(env) });
  const { cardIndexOf, hasNonCardShapes } = await import("../notebook/card-shape.ts");
  publishNotebookCards(fileId, cardIndexOf(env.shapes), { otherContent: hasNonCardShapes(env.shapes) });
  return true;
}

/** The middle of a notebook's saved view — where a card dropped on a
 *  closed notebook lands, so it is in front of the reader next time. */
function savedViewCentre(env) {
  const cam = env.camera || { x: 0, y: 0, zoom: 1 };
  const host = document.getElementById("notebook-container");
  const w = host?.clientWidth || window.innerWidth;
  const h = host?.clientHeight || window.innerHeight;
  return screenToWorld({ x: cam.x || 0, y: cam.y || 0, zoom: cam.zoom || 1, rotation: cam.rotation }, w / 2, h / 2);
}

/** Where a CARDS notebook's grid starts (card-courier.js): clear of the
 *  canvas toolbar at the default view, and of the files sidebar, taken
 *  to be open over the canvas's left edge — a card behind it would look
 *  like it never arrived. */
export function cardsGridOrigin() {
  return { x: getPanelWidthPx() + 40, y: 90 };
}

/**
 * Add a card to notebook `fileId`. `place` is "centre" (the middle of the
 * view, the sidebar drop) or "grid" (the next free slot of a grid from
 * `origin`, Courier's CARDS notebook).
 */
export async function addCardToNotebook(state, fileId, body, meta, { place = "centre", origin = { x: 0, y: 0 } } = {}) {
  const cs = await import("../notebook/card-shape.ts");
  const live = liveNotebook(fileId);
  if (live) {
    const s = live.state;
    if (place === "grid") cs.addCardShape(s, body, meta, cs.freeCardSlot(s.shapes, origin), { select: false });
    else cs.addCardShapeCentred(s, body, meta, viewCentreWorld(s));
    return;
  }
  await editNotebookOnDisk(fileId, (env) => {
    const layerId = Array.isArray(env.layers) && env.layers.length ? env.layers[0].id : undefined;
    let at;
    if (place === "grid") at = cs.freeCardSlot(env.shapes, origin);
    else {
      const c = savedViewCentre(env);
      const { width } = cardSize(meta);
      at = { x: c.x - width / 2, y: c.y - (meta?.collapsed ? CARD_HEADER_HEIGHT : CARD_DEFAULT_HEIGHT) / 2 };
    }
    env.shapes.push(cs.makeCardShape(body, meta, at, layerId));
  });
}

// ── Either ───────────────────────────────────────────────────────

/** Drop a card on a file named by its sidebar row. */
export async function deliverCardToFile(state, fileId, body, meta) {
  const node = findNodeByFileId(state.fileTree, fileId);
  if (!node) throw new Error("That file is gone");
  if (node.type === "document") await appendCardToDocument(state, fileId, body, meta);
  // A CARDS notebook keeps its grid; any other lands in the middle.
  else if (node.type === "notebook") {
    await addCardToNotebook(state, fileId, body, meta, isCardsHome(node) ? { place: "grid", origin: cardsGridOrigin() } : { place: "centre" });
  }
  else throw new Error("Cards go into documents and notebooks");
  return node.name;
}

/**
 * A card named by a sidebar row: `{ fileId, kind: "doc", index, body }`
 * (its place among the document's cards, and its text to confirm it
 * hasn't moved) or `{ fileId, kind: "nb", shapeId }`.
 */
function findDocCard(text, ref) {
  const cards = findCards(text);
  const at = cards[ref.index];
  if (at && at.body === ref.body) return at;
  return cards.find((c) => c.body === ref.body) || null;
}

/** The card a row stands for, as its file holds it now. */
export async function readCardRef(state, ref) {
  if (ref.kind === "doc") {
    const view = await liveDocView(state, ref.fileId);
    const text = view ? view.state.doc.toString()
      : (hasFileStore() ? (await invoke("load_file", { id: ref.fileId }))?.content || "" : "");
    const c = findDocCard(text, ref);
    return c ? { body: c.body, meta: c.meta } : null;
  }
  const cs = await import("../notebook/card-shape.ts");
  const live = liveNotebook(ref.fileId);
  let shape = null;
  if (live) shape = live.state.shapes.find((s) => s.id === ref.shapeId);
  else if (hasFileStore()) {
    const env = parseEnvelope((await invoke("load_file", { id: ref.fileId }))?.content);
    shape = env.shapes.find((s) => s.id === ref.shapeId);
  }
  return cs.isCardShape(shape) ? { body: shape.text, meta: cs.cardMetaOf(shape) } : null;
}

/** Take the card a row stands for out of its file. */
export async function removeCardRef(state, ref) {
  if (ref.kind === "doc") {
    return editDocument(state, ref.fileId, (text) => {
      const c = findDocCard(text, ref);
      if (!c) return null;
      const from = c.to < text.length ? c.from : Math.max(0, c.from - 1);
      const to = c.to < text.length ? c.to + 1 : c.to;
      return text.slice(0, from) + text.slice(to);
    }, "delete.card");
  }
  const cs = await import("../notebook/card-shape.ts");
  const live = liveNotebook(ref.fileId);
  if (live) return cs.removeCardShape(live.state, ref.shapeId);
  return editNotebookOnDisk(ref.fileId, (env) => {
    const before = env.shapes.length;
    env.shapes = env.shapes.filter((s) => s.id !== ref.shapeId);
    return env.shapes.length !== before;
  });
}
