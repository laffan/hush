/**
 * TEMPORARY stroke-engine test harness (see perf-panel.ts for the UI).
 *
 * Two entry points:
 *
 *   createTemplate(state)  — drops a grid of 100×100 drag-boxes, one per
 *     letter a–z, each labelled in its upper-left corner. The user
 *     handwrites the letter inside its box with any brush.
 *
 *   generateHandwriting(state, opts, cb, token) — clones the template
 *     strokes into synthetic "handwritten" paragraphs (~200 words each),
 *     committing one stroke at a time through the same state pipeline a
 *     real pen-up uses (shapes append → notify → recordHistory), so the
 *     long-session slowdown reproduces without 20 minutes of writing.
 *
 * Template boxes are tagged with a `perfChar` field that rides the JSON
 * envelope, so a template survives save/reload.
 */

import type { DrawShape, DragAreaShape, TextShape, Shape } from "./types";
import type { DrawingState } from "./state";
import { generateId, screenToCanvas } from "./utils";

const LETTERS = "abcdefghijklmnopqrstuvwxyz".split("");

/** Drag-area carrying the harness marker. Extra field is preserved by
 *  the persistence envelope (shapes serialize wholesale). */
type PerfBoxShape = DragAreaShape & { perfChar?: string };

const BOX = 100;
const GAP = 20;
const COLS = 7;

// ---------- template ----------

/** Create the a–z template grid near the current viewport top-left.
 *  Returns the number of boxes created. */
export function createTemplate(state: DrawingState): number {
  const origin = screenToCanvas({ x: 120, y: 140 }, state.camera);
  const added: Shape[] = [];
  const existing = collectTemplateBoxes(state);
  let created = 0;
  LETTERS.forEach((ch, i) => {
    if (existing.has(ch)) return; // don't duplicate boxes on re-click
    const col = i % COLS;
    const row = Math.floor(i / COLS);
    const x = origin.x + col * (BOX + GAP);
    const y = origin.y + row * (BOX + GAP);
    const boxId = generateId();
    const box: PerfBoxShape = {
      id: boxId,
      type: "drag-area",
      position: { x, y },
      width: BOX,
      height: BOX,
      color: "#6b7280",
      strokeColor: "#6b7280",
      backgroundColor: "rgba(107, 114, 128, 0.04)",
      borderRadius: 8,
      layerId: state.activeLayerId,
      perfChar: ch,
    };
    const label: TextShape = {
      id: generateId(),
      type: "text",
      position: { x: x + 6, y: y + 4 },
      text: ch,
      fontSize: 12,
      color: "#9ca3af",
      parentId: boxId,
      layerId: state.activeLayerId,
    };
    added.push(box, label);
    created++;
  });
  if (added.length) {
    state.shapes = [...state.shapes, ...added];
    state.recordHistory();
    state.notify("shapes");
  }
  return created;
}

function collectTemplateBoxes(state: DrawingState): Map<string, PerfBoxShape> {
  const out = new Map<string, PerfBoxShape>();
  for (const s of state.shapes) {
    if (s.type !== "drag-area") continue;
    const ch = (s as PerfBoxShape).perfChar;
    if (ch && !s.pocketed) out.set(ch, s as PerfBoxShape);
  }
  return out;
}

// ---------- template ink collection ----------

interface LetterInk {
  char: string;
  /** Strokes normalized so x starts at the ink's left edge and y is
   *  relative to the box top (keeps the user's in-box baseline). */
  strokes: {
    size: number;
    color: string;
    brushId: string;
    mode: "normal" | "highlighter";
    colorIsAuto?: boolean;
    colorIsHeading?: boolean;
    points: { x: number; y: number; pressure: number }[];
  }[];
  inkWidth: number;
}

/** Gather the handwritten strokes inside each template box. A stroke
 *  belongs to a box when its bounding-box centre falls inside it. */
export function collectTemplateInk(state: DrawingState): {
  letters: Map<string, LetterInk>;
  missing: string[];
  templateBottom: number;
  templateLeft: number;
} {
  const boxes = collectTemplateBoxes(state);
  const letters = new Map<string, LetterInk>();
  let templateBottom = -Infinity;
  let templateLeft = Infinity;
  for (const box of boxes.values()) {
    templateBottom = Math.max(templateBottom, box.position.y + box.height);
    templateLeft = Math.min(templateLeft, box.position.x);
  }

  for (const s of state.shapes) {
    if (s.type !== "draw" || s.pocketed) continue;
    const ds = s as DrawShape;
    if (!ds.points.length) continue;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of ds.points) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    for (const [ch, box] of boxes) {
      const bx = box.position.x, by = box.position.y;
      if (cx < bx || cx > bx + box.width || cy < by || cy > by + box.height) continue;
      let ink = letters.get(ch);
      if (!ink) {
        ink = { char: ch, strokes: [], inkWidth: 0 };
        letters.set(ch, ink);
      }
      ink.strokes.push({
        size: ds.size,
        color: ds.color,
        brushId: ds.brushId,
        mode: ds.mode,
        ...(ds.colorIsAuto ? { colorIsAuto: true } : {}),
        ...(ds.colorIsHeading ? { colorIsHeading: true } : {}),
        // Normalized per stroke set below (needs the letter-wide min X).
        points: ds.points.map((p) => ({ x: p.x, y: p.y - by, pressure: p.pressure })),
      });
      break;
    }
  }

  // Normalize each letter's x to its own ink-left edge and record width.
  for (const ink of letters.values()) {
    let minX = Infinity, maxX = -Infinity;
    for (const st of ink.strokes) {
      for (const p of st.points) {
        if (p.x < minX) minX = p.x;
        if (p.x > maxX) maxX = p.x;
      }
    }
    for (const st of ink.strokes) {
      for (const p of st.points) p.x -= minX;
    }
    ink.inkWidth = Math.max(4, maxX - minX);
  }

  const missing = LETTERS.filter((ch) => !letters.has(ch));
  return { letters, missing, templateBottom, templateLeft };
}

// ---------- word source ----------

const WORDS = (
  "the of and to in is was he for it with as his on be at by had not are but from or have an they " +
  "which one you were her all she there would their we him been has when who will more no if out so " +
  "said what up its about into than them can only other new some could time these two may then do " +
  "first any my now such like our over man me even most made after also did many before must through " +
  "back years where much your way well down should because each just those people how too little " +
  "state good very make world still own see men work long get here between both life being under " +
  "never day same another know while last might us great old year off come since against go came " +
  "right used take three states himself few house use during without again place around however " +
  "home small found thought went say part once general high upon school every don does got united " +
  "left number course war until always away something fact though water less public put think " +
  "almost hand enough far took head yet government system better set told nothing night end why " +
  "called didn eyes find going look asked later knew point next city business"
).split(/\s+/);

function randomWord(): string {
  return WORDS[Math.floor(Math.random() * WORDS.length)];
}

// ---------- generation ----------

export interface GenerateOptions {
  words: number;
  /** ~words per paragraph (default 200). */
  paragraphWords?: number;
  /** Scale applied to template ink (default 0.5 → ~50px letters). */
  scale?: number;
}

export interface GenerateCallbacks {
  onLog: (msg: string) => void;
  onProgress: (p: { strokes: number; words: number; totalWords: number }) => void;
  onDone: (summary: { strokes: number; points: number; words: number; elapsedMs: number; cancelled: boolean }) => void;
}

export interface CancelToken { cancelled: boolean; }
export function createCancelToken(): CancelToken { return { cancelled: false }; }

/** Clone template ink into synthetic handwriting, one committed stroke
 *  at a time. Commits deliberately mirror the real pen-up pipeline:
 *  append to state.shapes, notify("shapes") (→ sync shim → engine
 *  insert + bake), then state.recordHistory() — so the per-stroke costs
 *  match a live writing session. A macrotask yield between strokes
 *  keeps the UI painting and lets autosave ticks fire mid-run. */
export async function generateHandwriting(
  state: DrawingState,
  opts: GenerateOptions,
  cb: GenerateCallbacks,
  token: CancelToken,
): Promise<void> {
  const { letters, missing, templateBottom, templateLeft } = collectTemplateInk(state);
  if (letters.size === 0) {
    cb.onLog("generate: no template ink found — click Create Template and write a letter in each box first");
    cb.onDone({ strokes: 0, points: 0, words: 0, elapsedMs: 0, cancelled: false });
    return;
  }
  if (missing.length) {
    cb.onLog(`generate: no ink for [${missing.join(" ")}] — words will skip those letters`);
  }

  const scale = opts.scale ?? 0.5;
  const paragraphWords = opts.paragraphWords ?? 200;
  const LETTER_GAP = 8 * scale * 2;
  const SPACE_ADVANCE = 44 * scale;
  const LINE_HEIGHT = BOX * scale * 1.4;
  const LINE_WIDTH = 940;
  const startX = Number.isFinite(templateLeft) ? templateLeft : 0;
  const startY = (Number.isFinite(templateBottom) ? templateBottom : 0) + 80;

  let cursorX = startX;
  let cursorY = startY;
  let strokes = 0;
  let points = 0;
  let wordsDone = 0;
  const t0 = performance.now();
  cb.onLog(`generate: start — ${opts.words} words, scale ${scale}, ~${paragraphWords} words/paragraph`);

  const yieldMacrotask = () => new Promise<void>((r) => setTimeout(r, 0));

  for (let w = 0; w < opts.words; w++) {
    if (token.cancelled) break;
    const word = randomWord();
    const inks: LetterInk[] = [];
    for (const ch of word) {
      const ink = letters.get(ch);
      if (ink) inks.push(ink);
    }
    if (!inks.length) continue;
    // Word-level wrap.
    const wordAdvance = inks.reduce((acc, ink) => acc + ink.inkWidth * scale + LETTER_GAP, 0);
    if (cursorX + wordAdvance > startX + LINE_WIDTH) {
      cursorX = startX;
      cursorY += LINE_HEIGHT;
    }

    for (const ink of inks) {
      for (const st of ink.strokes) {
        if (token.cancelled) break;
        const shape: DrawShape = {
          id: generateId(),
          type: "draw",
          color: st.color,
          size: Math.max(0.75, st.size * scale),
          brushId: st.brushId,
          mode: st.mode,
          layerId: state.activeLayerId,
          ...(st.colorIsAuto ? { colorIsAuto: true } : {}),
          ...(st.colorIsHeading ? { colorIsHeading: true } : {}),
          points: st.points.map((p) => ({
            x: cursorX + p.x * scale,
            y: cursorY + p.y * scale,
            pressure: p.pressure,
          })),
        };
        // Mirror the real pen-up commit: append → notify → history.
        state.shapes = [...state.shapes, shape];
        state.notify("shapes");
        state.recordHistory();
        strokes++;
        points += shape.points.length;
        // One stroke per macrotask ≈ fast writing; lets rAF/autosave run.
        await yieldMacrotask();
      }
      cursorX += ink.inkWidth * scale + LETTER_GAP;
    }
    cursorX += SPACE_ADVANCE;
    wordsDone++;
    if (wordsDone % paragraphWords === 0) {
      cursorX = startX;
      cursorY += LINE_HEIGHT * 1.8;
    }
    if (wordsDone % 25 === 0) {
      cb.onProgress({ strokes, words: wordsDone, totalWords: opts.words });
    }
  }

  const elapsedMs = performance.now() - t0;
  cb.onDone({ strokes, points, words: wordsDone, elapsedMs, cancelled: token.cancelled });
}
