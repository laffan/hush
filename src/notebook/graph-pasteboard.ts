/**
 * Flowcharts across the pasteboard between Hush and Woods Whisper.
 *
 * Woods Whisper's graph documents are mind maps of cards, and each app
 * already copies its own: Hush a `canvas-clipboard@1` envelope as text,
 * Woods Whisper a JSON list of cards under its own pasteboard type
 * (`com.woodswhisper.graph-nodes`), with the cards' words beside it as
 * text. Neither is translated into the other on the way out; each side
 * recognises the other's on the way in.
 *
 *   - **Into Hush.** WebKit only hands a page plain text, HTML, images
 *     and URIs off the pasteboard, never another app's own type, so the
 *     cards are read natively (`commands/clipboard_graph.rs`). The
 *     native side asks whether the type is there before reading it,
 *     which iOS answers without its "Allow Paste" prompt — so only an
 *     actual Woods Whisper paste can raise it. A card becomes a text
 *     shape, a parent an arrow, and each shape is centred where its card
 *     was (a card's position is its centre; a shape's is its corner).
 *   - **Out of Hush.** On the Mac and the iPad a copy goes on the
 *     pasteboard under Hush's own type as well as as text
 *     (`com.hushwriter.canvas-clipboard`, the same JSON), so Woods
 *     Whisper can grey its Paste by asking after the type rather than by
 *     reading — and each shape's box rides along in the envelope
 *     (`bounds`), since a card is placed by its middle and only Hush can
 *     measure where that is.
 *
 * Anywhere without the native side (the browser build, other desktops)
 * both halves quietly fall back to what was there before: plain text.
 */
import type { Shape, TextShape, Bounds } from "./types";
import type { FlowEdge } from "./flowchart";
import { CLIPBOARD_SCHEMA, type ClipboardEnvelope } from "./clipboard-format";
import { getShapeBounds, getTextBounds } from "./utils";

const IS_TAURI: boolean =
  typeof window !== "undefined" &&
  (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ != null;

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(cmd, args);
}

/* ------------------------------------------------------------------ */
/* Out of Hush                                                          */
/* ------------------------------------------------------------------ */

/** The box a text shape's words take up — what a Woods Whisper card is
 *  centred on and sized by. A text shape's own bounds run the whole
 *  wrap width (350 by default) however short its words, which would
 *  turn "Yes" into a card the width of a paragraph; the words' own
 *  extent is the narrower of that width and the unwrapped line. Cards
 *  and outlines are frames, so their bounds are already the box. */
export function wordsBounds(shape: TextShape, fontFamily?: string): Bounds {
  const b = getShapeBounds(shape, fontFamily);
  if (shape.card || shape.outline) return b;
  const ff = shape.fontFamily || fontFamily;
  const line = getTextBounds(shape.position, shape.text, shape.fontSize, undefined, ff);
  return { ...b, maxX: b.minX + Math.min(b.maxX - b.minX, line.maxX - line.minX) };
}

/** Whether an envelope holds anything Woods Whisper can make a card of
 *  — only then is it worth putting under Hush's own type, or Woods
 *  Whisper would offer to paste a copy of ink it can do nothing with. */
function carriesText(json: string): boolean {
  try {
    const env = JSON.parse(json) as ClipboardEnvelope;
    return Array.isArray(env.shapes) && env.shapes.some((s) => {
      const t = s as { type?: string; text?: unknown } | null;
      return t?.type === "text" && typeof t.text === "string" && t.text.trim() !== "";
    });
  } catch {
    return false;
  }
}

/** Put a copy on the pasteboard natively — the JSON as text, and the
 *  same under Hush's own type. False where there's no native side or
 *  nothing in the copy for Woods Whisper, so the caller writes the text
 *  the way it always has. */
export async function writeCanvasPasteboard(json: string): Promise<boolean> {
  if (!IS_TAURI || !carriesText(json)) return false;
  try {
    await invoke("write_canvas_clipboard", { json });
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* Into Hush                                                            */
/* ------------------------------------------------------------------ */

/** Woods Whisper's cards on the pasteboard, as the JSON they travel in —
 *  "" when there are none or nothing can read them here. */
export async function readWoodsWhisperGraph(): Promise<string> {
  if (!IS_TAURI) return "";
  try {
    return (await invoke<string>("read_woods_whisper_graph")) || "";
  } catch {
    return "";
  }
}

/** A Woods Whisper card, as far as a text shape can use it. */
interface GraphCard {
  id: string;
  text: string;
  parentID?: string | null;
  position: { x: number; y: number };
  width?: number | null;
}

/** The width Woods Whisper draws a card nobody has resized at. */
const STANDARD_CARD_WIDTH = 180;

function isCard(n: unknown): n is GraphCard {
  const c = n as GraphCard;
  return !!c && typeof c.id === "string" && typeof c.text === "string" &&
    !!c.position && Number.isFinite(c.position.x) && Number.isFinite(c.position.y);
}

export interface CardStyle {
  fontSize: number;
  fontFamily?: string;
}

/**
 * Woods Whisper's copied cards as a `canvas-clipboard@1` envelope, ready
 * for `DrawingState.pasteEnvelope` — which mints fresh ids, puts the
 * whole copy in the middle of the view, and keeps it in the shape it
 * arrives in. Null for anything that isn't a copy of cards.
 *
 * A card with no words yet (a clip still transcribing when it was
 * copied) isn't given a shape, and whatever hung off it hangs off its
 * nearest worded ancestor instead — the way Woods Whisper's own outline
 * skips one. A loop of parents, which a pasteboard can't promise never
 * to hold, is cut where it closes.
 */
export function envelopeFromWoodsWhisper(json: string, style: CardStyle): ClipboardEnvelope | null {
  let parsed: unknown;
  try { parsed = JSON.parse(json); } catch { return null; }
  const list = (parsed as { nodes?: unknown })?.nodes;
  if (!Array.isArray(list)) return null;

  const cards = new Map<string, GraphCard>();
  for (const n of list) if (isCard(n) && !cards.has(n.id)) cards.set(n.id, n);
  const worded = (c: GraphCard) => c.text.trim().length > 0;

  const shapes: Shape[] = [];
  for (const card of cards.values()) {
    if (!worded(card)) continue;
    const width = card.width && card.width > 0 ? card.width : STANDARD_CARD_WIDTH;
    const box = getTextBounds({ x: 0, y: 0 }, card.text, style.fontSize, width, style.fontFamily);
    shapes.push({
      id: card.id,
      type: "text",
      text: card.text,
      fontSize: style.fontSize,
      width,
      color: "#000000",
      position: {
        x: card.position.x - (box.maxX - box.minX) / 2,
        y: card.position.y - (box.maxY - box.minY) / 2,
      },
    } as TextShape);
  }
  if (shapes.length === 0) return null;

  const flowEdges: FlowEdge[] = [];
  for (const card of cards.values()) {
    if (!worded(card)) continue;
    const seen = new Set<string>([card.id]);
    let up = card.parentID ? cards.get(card.parentID) : undefined;
    while (up && !worded(up) && !seen.has(up.id)) {
      seen.add(up.id);
      up = up.parentID ? cards.get(up.parentID) : undefined;
    }
    if (!up || seen.has(up.id) || closesLoop(cards, card.id, up.id)) continue;
    flowEdges.push({ id: `${up.id}>${card.id}`, from: up.id, to: card.id });
  }

  return { schema: CLIPBOARD_SCHEMA, shapes, flowEdges };
}

/** Whether hanging `child` off `parent` would close a loop: walking up
 *  from the parent by the cards' own pointers comes back to the child.
 *  Of the cards on a loop, those whose walk finds it are left as roots,
 *  which is enough to break it. */
function closesLoop(cards: Map<string, GraphCard>, child: string, parent: string): boolean {
  const seen = new Set<string>();
  let cur: string | null | undefined = parent;
  while (cur && !seen.has(cur)) {
    if (cur === child) return true;
    seen.add(cur);
    cur = cards.get(cur)?.parentID;
  }
  return false;
}
