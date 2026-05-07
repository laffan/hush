/* src/notebook/drawing/flyout-styles.ts
 *
 * One-shot injector for the notebook flyout's touch-friendly slider
 * styles. Both the brush-edit flyout (size / stream / spacing) and
 * the lasso hold-to-select flyout call `ensureFlyoutSliderStyle()` on
 * mount; the second call is a no-op. Track and thumb both square off
 * at 15 px so a finger or pencil tip lands cleanly without aiming at
 * a 4 px round thumb.
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
      border-radius: 0;
    }
    input[type="range"].notebook-flyout-slider::-webkit-slider-thumb {
      -webkit-appearance: none;
      appearance: none;
      width: 15px;
      height: 15px;
      background: var(--notebook-slider-thumb, #5a8ad8);
      border: none;
      border-radius: 0;
      margin-top: 0;
      cursor: ew-resize;
    }
    input[type="range"].notebook-flyout-slider::-moz-range-track {
      height: 15px;
      background: var(--notebook-slider-track, rgba(0,0,0,0.08));
      border: none;
      border-radius: 0;
    }
    input[type="range"].notebook-flyout-slider::-moz-range-thumb {
      width: 15px;
      height: 15px;
      background: var(--notebook-slider-thumb, #5a8ad8);
      border: none;
      border-radius: 0;
      cursor: ew-resize;
    }
  `;
  document.head.appendChild(style);
}

/** Theme the slider's thumb (and refresh the track tone) on a single
 *  input. The CSS variables are picked up by the rules above. Call
 *  whenever the active theme changes. */
export function applyFlyoutSliderTheme(input: HTMLInputElement, accent: string): void {
  input.style.setProperty("--notebook-slider-thumb", accent);
}
