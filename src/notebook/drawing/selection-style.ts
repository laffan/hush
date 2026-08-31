/**
 * Retroactive styling for the live drawing-mode selection. Pattern
 * mirrors the upstream demo's styleSession: snapshot baseline →
 * apply patch live → commit a single undo entry. The colorIsAuto tag
 * is handled here since the engine's setStrokesStyle doesn't know
 * about it.
 *
 * Pulled out of drawing-layer.ts as a factory that closes over the
 * deps it needs (selection / stroke engines, recordHistory hook,
 * theme ref, shim box). The shape returned matches the four interface
 * methods on DrawingLayer exactly (hasSelection, snapshotSelectedStyle,
 * applyStyleToSelection, commitStyleHistory).
 */
import type { EngineStroke } from "./sync-shim";
import type { SelectionStyleEntry, SelectionStylePatch } from "./drawing-layer-types";

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
  headingColor?: string;
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
  recordHistory: () => void;
}): SelectionStyleSession {
  const { selectionEngine, strokeEngine, shimBox, themeRef, recordHistory } = deps;

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
        ...(s.blend !== undefined ? { blend: s.blend } : {}),
        colorIsAuto: !!s.colorIsAuto,
        colorIsHeading: !!s.colorIsHeading,
      });
    }
    return map;
  }

  function applyStyleToSelection(patch: SelectionStylePatch): void {
    if (!selectionEngine.hasSelection()) return;
    const ids = selectionEngine.getSelectedIds();
    const enginePatch: Record<string, unknown> = {};
    if (patch.color !== undefined) {
      if (patch.color === "auto") {
        enginePatch.color = themeRef.foreground || "#111111";
      } else if (patch.color === "heading") {
        enginePatch.color = themeRef.headingColor || themeRef.foreground || "#111111";
      } else {
        enginePatch.color = patch.color;
      }
    }
    if (patch.size !== undefined) enginePatch.size = patch.size;
    if (patch.brushId !== undefined) enginePatch.brushId = patch.brushId;
    if (patch.mode !== undefined) enginePatch.mode = patch.mode;
    if (patch.blend !== undefined) enginePatch.blend = patch.blend;
    strokeEngine.setStrokesStyle(ids as Set<number>, enginePatch);
    if (patch.color !== undefined) {
      const isAuto = patch.color === "auto";
      const isHeading = patch.color === "heading";
      for (const s of strokeEngine.getStrokes() as EngineStroke[]) {
        if (ids.has(s.id)) {
          s.colorIsAuto = isAuto;
          s.colorIsHeading = isHeading;
        }
      }
    }
    // Sync the shim so state.shapes reflects the style change —
    // autosave and panes all pick it up.
    const shim = shimBox.current;
    if (shim) shim.onEngineStrokesTransformed(Array.from(ids));
    selectionEngine.refreshBBox();
  }

  function commitStyleHistory(before: Map<number, SelectionStyleEntry>): void {
    if (!before.size) return;
    // Detect whether anything actually changed since the snapshot.
    // recordHistory captures state.shapes wholesale, so we don't need
    // before/after closures — we just want to suppress the snapshot
    // when a session was opened but no slider actually moved.
    let changed = false;
    for (const s of strokeEngine.getStrokes() as EngineStroke[]) {
      const b = before.get(s.id);
      if (!b) continue;
      if (s.color !== b.color || s.size !== b.size ||
          s.brush !== b.brushId || s.mode !== b.mode ||
          s.blend !== b.blend ||
          !!s.colorIsAuto !== b.colorIsAuto ||
          !!s.colorIsHeading !== b.colorIsHeading) { changed = true; break; }
    }
    if (!changed) return;
    recordHistory();
  }

  return { hasSelection, snapshotSelectedStyle, applyStyleToSelection, commitStyleHistory };
}
