/* src/notebook/drawing/tool-panel-snap.ts
 *
 * Drag-snap drop-zone overlays for the notebook toolbar, extracted from
 * tool-panel.ts to keep it under the line limit. Three highlighted
 * strips — pinned to the top edge, the bottom edge, and the left edge
 * of the visible canvas — appear while the bar is being dragged;
 * dropping inside one snaps the toolbar to that position.
 */

import type { DrawingState } from "../state";

/** Margin of the drop zone from the canvas edge it represents. */
const SNAP_ZONE_MARGIN = 12;
/** Thickness of each drop zone strip. */
const SNAP_ZONE_THICKNESS = 80;

export type SnapEdge = "top" | "bottom" | "left";

export interface SnapZonesHandle {
  /** The three overlay strips, for mounting alongside the flyouts. */
  elements: HTMLElement[];
  /** Show / hide all zones (showing re-measures their positions). */
  show(on: boolean): void;
  /** Brighten the zone for `edge` (null resets all to the idle tint). */
  highlight(edge: SnapEdge | null): void;
  /** Which zone (if any) the client point falls inside. */
  hitTest(clientX: number, clientY: number): SnapEdge | null;
}

export function createSnapZones(state: DrawingState, bottomToolbar: HTMLElement): SnapZonesHandle {
  function makeZone(): HTMLElement {
    const z = document.createElement("div");
    z.className = "notebook-toolbar-snap-zone";
    Object.assign(z.style, {
      position: "absolute",
      display: "none",
      borderRadius: "12px",
      background: "rgba(66, 153, 225, 0.18)",
      border: "2px dashed rgba(66, 153, 225, 0.65)",
      pointerEvents: "none",
      zIndex: "99",
      transition: "background 80ms",
    } as Partial<CSSStyleDeclaration>);
    return z;
  }
  const zones: Record<SnapEdge, HTMLElement> = {
    top: makeZone(), bottom: makeZone(), left: makeZone(),
  };
  const all = [zones.top, zones.bottom, zones.left];

  function position(): void {
    const parent = bottomToolbar.parentElement;
    if (!parent) return;
    const r = parent.getBoundingClientRect();
    const leftInset = state.leftInset || 0;
    const rightInset = state.rightInset || 0;
    const innerW = r.width - leftInset - rightInset;
    const innerX = leftInset;
    const zoneW = Math.min(innerW * 0.7, 600);
    const zoneX = innerX + (innerW - zoneW) / 2;
    Object.assign(zones.top.style, {
      left: `${zoneX}px`, top: `${SNAP_ZONE_MARGIN}px`,
      width: `${zoneW}px`, height: `${SNAP_ZONE_THICKNESS}px`,
    });
    Object.assign(zones.bottom.style, {
      left: `${zoneX}px`, top: `${r.height - SNAP_ZONE_MARGIN - SNAP_ZONE_THICKNESS}px`,
      width: `${zoneW}px`, height: `${SNAP_ZONE_THICKNESS}px`,
    });
    const zoneH = Math.min(r.height * 0.7, 600);
    Object.assign(zones.left.style, {
      left: `${leftInset + SNAP_ZONE_MARGIN}px`, top: `${(r.height - zoneH) / 2}px`,
      width: `${SNAP_ZONE_THICKNESS}px`, height: `${zoneH}px`,
    });
  }

  function show(on: boolean): void {
    for (const z of all) {
      z.style.display = on ? "block" : "none";
      z.style.background = "rgba(66, 153, 225, 0.18)";
    }
    if (on) position();
  }

  function highlight(edge: SnapEdge | null): void {
    for (const [key, z] of Object.entries(zones)) {
      z.style.background = key === edge ? "rgba(66, 153, 225, 0.40)" : "rgba(66, 153, 225, 0.18)";
    }
  }

  function hitTest(clientX: number, clientY: number): SnapEdge | null {
    for (const [key, z] of Object.entries(zones)) {
      const r = z.getBoundingClientRect();
      if (clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom) {
        return key as SnapEdge;
      }
    }
    return null;
  }

  return { elements: all, show, highlight, hitTest };
}
