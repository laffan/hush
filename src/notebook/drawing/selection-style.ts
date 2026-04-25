/**
 * Retroactive styling for the live drawing-mode selection. Pattern
 * mirrors the upstream demo's styleSession: snapshot baseline →
 * apply patch live → commit a single undo entry. The colorIsAuto tag
 * is handled here since the engine's setStrokesStyle doesn't know
 * about it.
 *
 * Pulled out of drawing-layer.ts as a factory that closes over the
 * deps it needs (selection / stroke engines, history, theme ref,
 * shim box). The shape returned matches the four interface methods on
 * DrawingLayer exactly (hasSelection, snapshotSelectedStyle,
 * applyStyleToSelection, commitStyleHistory).
 */
import type { EngineStroke } from "./sync-shim";
import type { SelectionStyleEntry, SelectionStylePatch } from "./drawing-layer-types";

interface History {
  push(entry: { undo: () => void; redo: () => void }): void;
}

interface SelectionEngine {
  hasSelection(): boolean;
  getSelectedIds(): Set<number>;
  refreshBBox(): void;
}

interface StrokeEngine {
  getStrokes(): EngineStroke[];
  setStrokesStyle(ids: Set<number>, patch: Record<string, unknown>): void;
  setStrokesStyleMap(map: Map<number, object>): void;
}

interface ShimBox {
  current: { onEngineStrokesTransformed(ids: number[]): void } | null;
}

interface ThemeRef {
  foreground?: string;
}

export interface SelectionStyleSession {
  hasSelection(): boolean;
  snapshotSelectedStyle(): Map<number, SelectionStyleEntry>;
  applyStyleToSelection(patch: SelectionStylePatch): void;
  commitStyleHistory(beforeMap: Map<number, SelectionStyleEntry>): void;
}

export function createSelectionStyleSession(deps: {
  selectionEngine: SelectionEngine;
  strokeEngine: StrokeEngine;
  shimBox: ShimBox;
  themeRef: ThemeRef;
  history: History;
}): SelectionStyleSession {
  const { selectionEngine, strokeEngine, shimBox, themeRef, history } = deps;

  function hasSelection(): boolean {
    return selectionEngine.hasSelection();
  }

  function snapshotSelectedStyle(): Map<number, SelectionStyleEntry> {
    const ids = selectionEngine.getSelectedIds();
    const map = new Map<number, SelectionStyleEntry>();
    if (!ids.size) return map;
    for (const s of strokeEngine.getStrokes() as EngineStroke[]) {
      if (!ids.has(s.id)) continue;
      map.set(s.id, {
        color: s.color,
        size: s.size,
        brushId: s.brush,
        mode: s.mode,
        colorIsAuto: !!s.colorIsAuto,
      });
    }
    return map;
  }

  function applyStyleToSelection(patch: SelectionStylePatch): void {
    if (!selectionEngine.hasSelection()) return;
    const ids = selectionEngine.getSelectedIds();
    const enginePatch: Record<string, unknown> = {};
    if (patch.color !== undefined) {
      enginePatch.color = patch.color === "auto" ? (themeRef.foreground || "#111111") : patch.color;
    }
    if (patch.size !== undefined) enginePatch.size = patch.size;
    if (patch.brushId !== undefined) enginePatch.brushId = patch.brushId;
    if (patch.mode !== undefined) enginePatch.mode = patch.mode;
    strokeEngine.setStrokesStyle(ids as Set<number>, enginePatch);
    if (patch.color !== undefined) {
      const isAuto = patch.color === "auto";
      for (const s of strokeEngine.getStrokes() as EngineStroke[]) {
        if (ids.has(s.id)) s.colorIsAuto = isAuto;
      }
    }
    // Sync the shim so state.shapes reflects the style change —
    // autosave, Dropbox, panes all pick it up.
    const shim = shimBox.current;
    if (shim) shim.onEngineStrokesTransformed(Array.from(ids));
    selectionEngine.refreshBBox();
  }

  function commitStyleHistory(before: Map<number, SelectionStyleEntry>): void {
    if (!before.size) return;
    // Snapshot post-state for the same ids.
    const after = new Map<number, SelectionStyleEntry>();
    for (const s of strokeEngine.getStrokes() as EngineStroke[]) {
      if (!before.has(s.id)) continue;
      after.set(s.id, {
        color: s.color, size: s.size, brushId: s.brush, mode: s.mode,
        colorIsAuto: !!s.colorIsAuto,
      });
    }
    // Bail if nothing changed.
    let changed = false;
    for (const [id, b] of before) {
      const a = after.get(id);
      if (!a) continue;
      if (a.color !== b.color || a.size !== b.size ||
          a.brushId !== b.brushId || a.mode !== b.mode ||
          a.colorIsAuto !== b.colorIsAuto) { changed = true; break; }
    }
    if (!changed) return;
    const restore = (map: Map<number, SelectionStyleEntry>) => {
      const styleMap = new Map<number, object>();
      for (const [id, e] of map) {
        styleMap.set(id, {
          color: e.color, size: e.size, brushId: e.brushId, mode: e.mode,
        });
      }
      strokeEngine.setStrokesStyleMap(styleMap);
      for (const s of strokeEngine.getStrokes() as EngineStroke[]) {
        const e = map.get(s.id);
        if (e) s.colorIsAuto = e.colorIsAuto;
      }
      const shim = shimBox.current;
      if (shim) shim.onEngineStrokesTransformed(Array.from(map.keys()));
      selectionEngine.refreshBBox();
    };
    history.push({
      undo: () => restore(before),
      redo: () => restore(after),
    });
  }

  return { hasSelection, snapshotSelectedStyle, applyStyleToSelection, commitStyleHistory };
}
