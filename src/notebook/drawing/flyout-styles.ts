/* src/notebook/drawing/flyout-styles.ts
 *
 * One-shot injectors for the notebook flyouts' shared styles.
 *
 * `ensureFlyoutSliderStyle()` — touch-friendly slider chrome. Both the
 * brush-edit flyout (size / stream / spacing) and the lasso
 * hold-to-select flyout call it on mount; the second call is a no-op.
 * Track and thumb are both 15 px thick (with a soft 4 px radius) so a
 * finger or pencil tip lands cleanly without aiming at a 4 px round
 * thumb.
 *
 * `ensureBrushFlyoutStyle()` — the brush-edit panel's component
 * classes (section labels, hairline dividers, brush cells, color
 * swatches, mode segments). Everything theme-dependent reads CSS
 * variables (`--nbf-*`) that brush-slots.ts sets on the flyout root
 * from the active canvas theme, so a theme switch restyles the whole
 * panel without touching per-element inline styles.
 */

let _injected = false;

export function ensureFlyoutSliderStyle(): void {
  if (_injected || typeof document === "undefined") return;
  _injected = true;
  const style = document.createElement("style");
  style.setAttribute("data-hush-notebook-slider", "");
  style.textContent = `
    input[type="range"].notebook-flyout-slider {
      -webkit-appearance: none;
      appearance: none;
      height: 15px;
      background: transparent;
      border: none;
      border-radius: 0;
      outline: none;
      padding: 0;
      margin: 0;
    }
    input[type="range"].notebook-flyout-slider::-webkit-slider-runnable-track {
      height: 15px;
      background: var(--notebook-slider-track, rgba(0,0,0,0.08));
      border: none;
      border-radius: 4px;
    }
    input[type="range"].notebook-flyout-slider::-webkit-slider-thumb {
      -webkit-appearance: none;
      appearance: none;
      width: 15px;
      height: 15px;
      background: var(--notebook-slider-thumb, #5a8ad8);
      border: none;
      border-radius: 4px;
      margin-top: 0;
      cursor: ew-resize;
    }
    input[type="range"].notebook-flyout-slider::-moz-range-track {
      height: 15px;
      background: var(--notebook-slider-track, rgba(0,0,0,0.08));
      border: none;
      border-radius: 4px;
    }
    input[type="range"].notebook-flyout-slider::-moz-range-thumb {
      width: 15px;
      height: 15px;
      background: var(--notebook-slider-thumb, #5a8ad8);
      border: none;
      border-radius: 4px;
      cursor: ew-resize;
    }
  `;
  document.head.appendChild(style);
}

/** Theme the slider's thumb + track tone on a single input. The CSS
 *  variables are picked up by the rules above. Call whenever the
 *  active theme changes. `variant` fixes the track for dark themes —
 *  without it the default near-black wash disappears against a dark
 *  panel. */
export function applyFlyoutSliderTheme(input: HTMLInputElement, accent: string, variant?: "light" | "dark"): void {
  input.style.setProperty("--notebook-slider-thumb", accent);
  input.style.setProperty(
    "--notebook-slider-track",
    variant === "dark" ? "rgba(255,255,255,0.10)" : "rgba(0,0,0,0.08)",
  );
}

/** Translucent wash of an accent colour, computed in JS so it works on
 *  every WebKit vintage (no color-mix dependency). Accepts #rgb /
 *  #rrggbb; anything else falls back to the stock blue at the same
 *  alpha. */
export function accentTint(color: string, alpha: number): string {
  const m3 = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(color);
  const m6 = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(color);
  const [r, g, b] = m6
    ? [parseInt(m6[1], 16), parseInt(m6[2], 16), parseInt(m6[3], 16)]
    : m3
      ? [parseInt(m3[1] + m3[1], 16), parseInt(m3[2] + m3[2], 16), parseInt(m3[3] + m3[3], 16)]
      : [66, 133, 244];
  return `rgba(${r},${g},${b},${alpha})`;
}

let _brushInjected = false;

/** One-shot stylesheet for the brush-edit flyout's components. All
 *  colours route through `--nbf-*` variables set on the flyout root
 *  by brush-slots.ts (`applyFlyoutTheme`), so the sheet itself is
 *  theme-agnostic. Hover rules only fire on mouse-driven devices;
 *  iPad ignores them. */
export function ensureBrushFlyoutStyle(): void {
  if (_brushInjected || typeof document === "undefined") return;
  _brushInjected = true;
  const style = document.createElement("style");
  style.setAttribute("data-hush-notebook-brush-flyout", "");
  style.textContent = `
    .notebook-brush-flyout {
      font-family: var(--ui-font-family, system-ui, sans-serif);
    }
    .notebook-brush-flyout button {
      transition: background 0.15s, border-color 0.15s, box-shadow 0.15s,
                  color 0.15s, opacity 0.15s, transform 0.15s;
    }
    .notebook-brush-flyout .nbf-label {
      font: 600 10px/1 var(--ui-font-family, system-ui, sans-serif);
      text-transform: uppercase;
      letter-spacing: 0.06em;
      opacity: 0.6;
      margin-bottom: 8px;
    }
    .notebook-brush-flyout .nbf-divider {
      height: 1px;
      background: var(--nbf-border);
      margin: 12px 0;
    }
    .notebook-brush-flyout .nbf-row-label {
      font: 500 11px/1.2 var(--ui-font-family, system-ui, sans-serif);
      opacity: 0.7;
    }
    .notebook-brush-flyout .nbf-row-val {
      font: 500 11px/1.2 var(--ui-font-family, system-ui, sans-serif);
      font-variant-numeric: tabular-nums;
      opacity: 0.7;
      text-align: right;
    }
    /* Brush cells — canvas-coloured tiles so the tip preview reads in
       its true rendering context; the active cell swaps its hairline
       border for a 2px accent ring. */
    .notebook-brush-flyout .nbf-cell {
      width: 40px;
      height: 40px;
      padding: 0;
      border: 1px solid var(--nbf-border);
      border-radius: 8px;
      background: var(--nbf-canvas);
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .notebook-brush-flyout .nbf-cell.nbf-active {
      border-color: transparent;
      box-shadow: 0 0 0 2px var(--nbf-accent);
      /* Accent wash layered over the canvas tone so the active tip
         still previews in its true rendering context. */
      background: linear-gradient(var(--nbf-accent-tint), var(--nbf-accent-tint)), var(--nbf-canvas);
    }
    .notebook-brush-flyout .nbf-cell:not(.nbf-active):hover {
      border-color: var(--nbf-accent);
    }
    /* Color swatches — flat circles with a faint inner edge so light
       swatches keep definition; the active one gets the gap-and-ring
       treatment. */
    .notebook-brush-flyout .nbf-swatch {
      width: 22px;
      height: 22px;
      padding: 0;
      border: none;
      border-radius: 50%;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      font: 700 10px/1 var(--ui-font-family, system-ui, sans-serif);
      box-shadow: inset 0 0 0 1px var(--nbf-swatch-edge);
    }
    .notebook-brush-flyout .nbf-swatch.nbf-active {
      box-shadow: inset 0 0 0 1px var(--nbf-swatch-edge),
                  0 0 0 2px var(--nbf-panel),
                  0 0 0 4px var(--nbf-accent);
    }
    .notebook-brush-flyout .nbf-swatch:not(.nbf-active):hover {
      transform: scale(1.12);
    }
    /* Mode — segmented control. */
    .notebook-brush-flyout .nbf-mode {
      display: flex;
      gap: 2px;
      padding: 2px;
      border-radius: 8px;
      background: var(--nbf-subtle);
    }
    .notebook-brush-flyout .nbf-seg {
      flex: 1;
      padding: 5px 10px;
      border: none;
      border-radius: 6px;
      background: transparent;
      color: inherit;
      opacity: 0.65;
      font: 500 12px/1.2 var(--ui-font-family, system-ui, sans-serif);
      cursor: pointer;
    }
    .notebook-brush-flyout .nbf-seg.nbf-active {
      background: var(--nbf-accent);
      color: #fff;
      opacity: 1;
      box-shadow: 0 1px 3px rgba(0,0,0,0.18);
    }
    .notebook-brush-flyout .nbf-seg:not(.nbf-active):hover {
      opacity: 1;
    }
  `;
  document.head.appendChild(style);
}
