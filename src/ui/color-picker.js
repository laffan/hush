/**
 * Custom colour picker popup — a rainbow hue slider and an opacity
 * slider over a saturation (x) / brightness (y) gradient field.
 *
 * Used by the Style Editor in place of the platform colour panel. The
 * native panel is a full-screen system sheet on iPadOS: it covers the
 * live preview the modal exists to show, and on macOS it opens a
 * detached window that outlives the modal. This popup sits next to the
 * swatch, so every drag repaints the preview underneath it.
 *
 * ## Integration contract
 *
 * `installColorPickers(root)` leaves every `input[type="color"]` in the
 * DOM exactly where it was and keeps it as the value carrier: callers go
 * on reading `input.value` and listening for `input` / `change`. The
 * input is only wrapped in a positioned span and made
 * `pointer-events: none`, with a transparent hit layer on top that opens
 * this popup instead. Nothing has to be re-wired when a section
 * re-renders — a MutationObserver picks new inputs up — and because the
 * native input still paints the swatch, a value assigned from outside
 * (`el.value = "#abc"`, as the gradient pad does when the selected node
 * changes) shows through with no syncing on our side.
 *
 * HSV is held on the popup, not re-derived from the hex on every move:
 * black and white have no hue or saturation to read back, so a round
 * trip through the hex would collapse the pointer's position the moment
 * a drag touched an edge of the field.
 *
 * ## Opacity
 *
 * `input[type="color"]` has nowhere to put an alpha channel — its value
 * is `#rrggbb` and the browser normalises anything else away. So opacity
 * rides *beside* the value, on `input.dataset.alpha` ("0"–"1"), written
 * in the same coalesced flush as the hex and followed by the same
 * `input` / `change` events. A consumer folds the two into one CSS
 * colour with `joinAlphaColor`, and unfolds a stored one with
 * `splitAlphaColor`.
 *
 * **The slider is opt-in**, and the presence of `data-alpha` on the
 * input is the opt: an input that doesn't carry it gets no opacity
 * track. Half the colour wells in the style editor sit beside an opacity
 * control of their own (a layer's, a gradient node's), and a second
 * slider that silently didn't apply would be worse than no slider at
 * all. Opting one in is one attribute.
 */

// ── colour maths ──────────────────────────────────────────────────────────

/** "#rgb" / "#rgba" / "#rrggbb" / "#rrggbbaa" / "rgb(a)(...)" →
 *  `{ r, g, b, a }` (channels 0-255, `a` 0-1), or null. `a` is 1 for any
 *  notation that doesn't carry one. */
export function parseColor(str) {
  if (typeof str !== "string") return null;
  const s = str.trim();
  const hex = s.startsWith("#") ? s.slice(1) : s;
  const dup = (c) => parseInt(c + c, 16);
  if (/^[0-9a-f]{3,4}$/i.test(hex)) {
    return {
      r: dup(hex[0]), g: dup(hex[1]), b: dup(hex[2]),
      a: hex.length === 4 ? dup(hex[3]) / 255 : 1,
    };
  }
  if (/^[0-9a-f]{6}$/i.test(hex) || /^[0-9a-f]{8}$/i.test(hex)) {
    return {
      r: parseInt(hex.slice(0, 2), 16),
      g: parseInt(hex.slice(2, 4), 16),
      b: parseInt(hex.slice(4, 6), 16),
      a: hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1,
    };
  }
  const m = s.match(/^rgba?\(([^)]+)\)$/i);
  if (m) {
    const parts = m[1].split(/[,\s/]+/).filter(Boolean).map(p => parseFloat(p));
    if (parts.length >= 3 && parts.slice(0, 3).every(n => Number.isFinite(n))) {
      return {
        r: clamp(parts[0], 0, 255), g: clamp(parts[1], 0, 255), b: clamp(parts[2], 0, 255),
        a: Number.isFinite(parts[3]) ? clamp(parts[3], 0, 1) : 1,
      };
    }
  }
  return null;
}

/** Alpha as the two hex digits `#rrggbbaa` wants. */
function alphaHex(a) {
  return Math.round(clamp(a, 0, 1) * 255).toString(16).padStart(2, "0");
}

/**
 * Split a stored colour into the parts an `input[type="color"]` and its
 * `dataset.alpha` hold. Anything unparseable comes back as opaque black,
 * which is what the input would have shown anyway.
 */
export function splitAlphaColor(value) {
  const rgb = parseColor(value);
  if (!rgb) return { hex: "#000000", alpha: 1 };
  return { hex: toHex(rgb.r, rgb.g, rgb.b), alpha: rgb.a };
}

/**
 * Fold a swatch's value and its opacity back into one CSS colour.
 * Full opacity stays `#rrggbb` — an `ff` on the end of every colour a
 * user never made translucent is noise in the stored style, and in the
 * hex field they read it back from.
 */
export function joinAlphaColor(hex, alpha) {
  const a = alpha == null || alpha === "" ? 1 : clamp(parseFloat(alpha), 0, 1);
  if (!Number.isFinite(a) || a >= 1) return hex;
  return `${hex}${alphaHex(a)}`;
}

function clamp(n, lo, hi) { return n < lo ? lo : n > hi ? hi : n; }

function toHex(r, g, b) {
  const h = (n) => Math.round(clamp(n, 0, 255)).toString(16).padStart(2, "0");
  return `#${h(r)}${h(g)}${h(b)}`;
}

/** `{ r, g, b }` (0-255) → `{ h: 0-360, s: 0-1, v: 0-1 }`. */
export function rgbToHsv({ r, g, b }) {
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === rn) h = ((gn - bn) / d) % 6;
    else if (max === gn) h = (bn - rn) / d + 2;
    else h = (rn - gn) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s: max === 0 ? 0 : d / max, v: max };
}

/** `{ h, s, v }` → `{ r, g, b }` (0-255). */
export function hsvToRgb({ h, s, v }) {
  const hh = ((h % 360) + 360) % 360 / 60;
  const c = v * s;
  const x = c * (1 - Math.abs((hh % 2) - 1));
  const m = v - c;
  let rgb;
  if (hh < 1) rgb = [c, x, 0];
  else if (hh < 2) rgb = [x, c, 0];
  else if (hh < 3) rgb = [0, c, x];
  else if (hh < 4) rgb = [0, x, c];
  else if (hh < 5) rgb = [x, 0, c];
  else rgb = [c, 0, x];
  return { r: (rgb[0] + m) * 255, g: (rgb[1] + m) * 255, b: (rgb[2] + m) * 255 };
}

export function hsvToHex(hsv) {
  const { r, g, b } = hsvToRgb(hsv);
  return toHex(r, g, b);
}

// ── the popup ─────────────────────────────────────────────────────────────

let openPicker = null; // { el, close } — one at a time, app-wide

/**
 * Open the picker over `anchorEl`, driving `input`.
 * Returns a `close()` for callers that need to dismiss it themselves.
 */
export function openColorPicker(input, anchorEl) {
  closeColorPicker();

  const rgb = parseColor(input.value) || { r: 128, g: 128, b: 128, a: 1 };
  const hsv = rgbToHsv(rgb);
  // Opacity rides beside the value rather than in it — see the module
  // header. No `data-alpha` at all means nobody has opted in, and a
  // colour nobody has made translucent is opaque.
  const allowAlpha = input.dataset.alpha != null;
  const startAlpha = parseFloat(input.dataset.alpha);
  let alpha = Number.isFinite(startAlpha) ? clamp(startAlpha, 0, 1) : 1;

  const el = document.createElement("div");
  el.className = "hush-colorpick";
  el.setAttribute("role", "dialog");
  el.setAttribute("aria-label", "Colour picker");
  el.innerHTML = `
    <div class="hush-colorpick-hue" tabindex="0" role="slider"
         aria-label="Hue" aria-valuemin="0" aria-valuemax="360">
      <div class="hush-colorpick-hue-thumb"></div>
    </div>
    <div class="hush-colorpick-alpha" tabindex="0" role="slider"
         aria-label="Opacity" aria-valuemin="0" aria-valuemax="100">
      <div class="hush-colorpick-alpha-ramp"></div>
      <div class="hush-colorpick-alpha-thumb"></div>
    </div>
    <div class="hush-colorpick-field" tabindex="0" role="application"
         aria-label="Saturation and brightness">
      <div class="hush-colorpick-field-thumb"></div>
    </div>
    <div class="hush-colorpick-foot">
      <span class="hush-colorpick-swatch"></span>
      <input class="hush-colorpick-hex" type="text" spellcheck="false"
             autocomplete="off" aria-label="Hex colour" maxlength="9" />
    </div>`;
  document.body.appendChild(el);

  const hueBar = el.querySelector(".hush-colorpick-hue");
  const hueThumb = el.querySelector(".hush-colorpick-hue-thumb");
  const alphaBar = el.querySelector(".hush-colorpick-alpha");
  const alphaRamp = el.querySelector(".hush-colorpick-alpha-ramp");
  const alphaThumb = el.querySelector(".hush-colorpick-alpha-thumb");
  if (!allowAlpha) alphaBar.remove();
  const field = el.querySelector(".hush-colorpick-field");
  const fieldThumb = el.querySelector(".hush-colorpick-field-thumb");
  const swatch = el.querySelector(".hush-colorpick-swatch");
  const hexInput = el.querySelector(".hush-colorpick-hex");

  // Every drag frame runs the host's live preview (which re-applies the
  // draft style), so writes are coalesced onto one rAF rather than
  // firing per pointermove sample.
  let frame = 0;
  let pendingFinal = false;

  function paint() {
    const hex = hsvToHex(hsv);
    field.style.background =
      `linear-gradient(to top, #000, rgba(0,0,0,0)),`
      + `linear-gradient(to right, #fff, hsl(${hsv.h.toFixed(1)}, 100%, 50%))`;
    hueThumb.style.left = `${(hsv.h / 360) * 100}%`;
    hueBar.setAttribute("aria-valuenow", String(Math.round(hsv.h)));
    fieldThumb.style.left = `${hsv.s * 100}%`;
    fieldThumb.style.top = `${(1 - hsv.v) * 100}%`;
    fieldThumb.style.background = hex;
    // The opacity ramp runs from transparent to the colour currently
    // picked, over the checkerboard the track carries — so the slider
    // shows this colour fading rather than a generic grey wedge.
    if (allowAlpha) {
      alphaRamp.style.background = `linear-gradient(to right, ${hex}00, ${hex})`;
      alphaThumb.style.left = `${alpha * 100}%`;
      alphaThumb.style.background = joinAlphaColor(hex, alpha);
      alphaBar.setAttribute("aria-valuenow", String(Math.round(alpha * 100)));
    }
    const shown = allowAlpha ? joinAlphaColor(hex, alpha) : hex;
    swatch.style.setProperty("--swatch-color", shown);
    if (document.activeElement !== hexInput) hexInput.value = shown;
  }

  function flush() {
    frame = 0;
    const wasFinal = pendingFinal;
    pendingFinal = false;
    const hex = hsvToHex(hsv);
    const nextAlpha = String(alpha);
    const changed = input.value.toLowerCase() !== hex
      || (allowAlpha && input.dataset.alpha !== nextAlpha);
    input.value = hex;
    // Written before the event, so a listener reading both sees one
    // colour rather than the new hex at the old opacity.
    if (allowAlpha) input.dataset.alpha = nextAlpha;
    if (changed) input.dispatchEvent(new Event("input", { bubbles: true }));
    if (wasFinal) input.dispatchEvent(new Event("change", { bubbles: true }));
  }

  /** Push the current HSV onto the host input. `final` also fires
   *  `change`, which is what a drag release / hex commit counts as. */
  function push(final) {
    pendingFinal = pendingFinal || !!final;
    if (frame) return;
    frame = requestAnimationFrame(flush);
  }

  /** Shared pointer-drag plumbing for both surfaces. `read(e, rect)`
   *  maps a pointer position onto `hsv`. */
  function draggable(surface, read) {
    surface.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const rect = surface.getBoundingClientRect();
      surface.setPointerCapture(e.pointerId);
      read(e, rect);
      paint();
      push(false);
      const onMove = (me) => { read(me, rect); paint(); push(false); };
      const onUp = () => {
        surface.removeEventListener("pointermove", onMove);
        surface.removeEventListener("pointerup", onUp);
        surface.removeEventListener("pointercancel", onUp);
        push(true);
      };
      surface.addEventListener("pointermove", onMove);
      surface.addEventListener("pointerup", onUp);
      // iOS claims a touch for scrolling with `pointercancel` rather
      // than `pointerup` — without this the drag never commits.
      surface.addEventListener("pointercancel", onUp);
    });
  }

  draggable(hueBar, (e, rect) => {
    hsv.h = clamp((e.clientX - rect.left) / rect.width, 0, 1) * 360;
  });
  draggable(field, (e, rect) => {
    hsv.s = clamp((e.clientX - rect.left) / rect.width, 0, 1);
    hsv.v = 1 - clamp((e.clientY - rect.top) / rect.height, 0, 1);
  });
  if (allowAlpha) {
    draggable(alphaBar, (e, rect) => {
      alpha = clamp((e.clientX - rect.left) / rect.width, 0, 1);
    });
  }

  // Arrow keys nudge whichever surface has focus — 1 unit, 10 with shift.
  hueBar.addEventListener("keydown", (e) => {
    const step = (e.shiftKey ? 10 : 1) * (e.key === "ArrowLeft" ? -1 : e.key === "ArrowRight" ? 1 : 0);
    if (!step) return;
    e.preventDefault();
    hsv.h = ((hsv.h + step) % 360 + 360) % 360;
    paint();
    push(true);
  });
  if (allowAlpha) alphaBar.addEventListener("keydown", (e) => {
    const step = (e.shiftKey ? 0.1 : 0.01)
      * (e.key === "ArrowLeft" ? -1 : e.key === "ArrowRight" ? 1 : 0);
    if (!step) return;
    e.preventDefault();
    alpha = clamp(alpha + step, 0, 1);
    paint();
    push(true);
  });
  field.addEventListener("keydown", (e) => {
    const d = e.shiftKey ? 0.1 : 0.01;
    let dx = 0, dy = 0;
    if (e.key === "ArrowLeft") dx = -d;
    else if (e.key === "ArrowRight") dx = d;
    else if (e.key === "ArrowUp") dy = d;
    else if (e.key === "ArrowDown") dy = -d;
    else return;
    e.preventDefault();
    hsv.s = clamp(hsv.s + dx, 0, 1);
    hsv.v = clamp(hsv.v + dy, 0, 1);
    paint();
    push(true);
  });

  const commitHex = () => {
    const parsed = parseColor(hexInput.value);
    if (!parsed) { paint(); return; }
    Object.assign(hsv, rgbToHsv(parsed));
    // A typed `#rrggbbaa` sets the slider too; a typed `#rrggbb` reads
    // as "fully opaque", which is what it means everywhere else.
    if (allowAlpha) alpha = parsed.a;
    paint();
    push(true);
  };
  hexInput.addEventListener("change", commitHex);
  hexInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); commitHex(); close(); }
    else if (e.key === "Escape") { e.preventDefault(); close(); }
  });

  paint();
  position(el, anchorEl);

  function onOutside(e) {
    if (el.contains(e.target) || anchorEl.contains(e.target)) return;
    close();
  }
  function onKey(e) {
    if (e.key === "Escape") { e.stopPropagation(); close(); }
  }
  function onReflow() { position(el, anchorEl); }

  function close() {
    if (openPicker?.el !== el) return;
    openPicker = null;
    // Land the last coalesced write rather than dropping it — closing
    // right after a drag release would otherwise lose the final few
    // milliseconds of movement and the `change` that commits it.
    if (frame) { cancelAnimationFrame(frame); flush(); }
    document.removeEventListener("pointerdown", onOutside, true);
    document.removeEventListener("keydown", onKey, true);
    window.removeEventListener("resize", onReflow);
    window.removeEventListener("scroll", onReflow, true);
    el.remove();
  }

  // Armed next frame: the pointerdown that opened us is still in flight,
  // and on iOS the synthetic mouse event trails it by hundreds of ms.
  requestAnimationFrame(() => {
    if (openPicker?.el !== el) return;
    document.addEventListener("pointerdown", onOutside, true);
  });
  document.addEventListener("keydown", onKey, true);
  window.addEventListener("resize", onReflow);
  window.addEventListener("scroll", onReflow, true);

  openPicker = { el, close };
  return close;
}

export function closeColorPicker() {
  if (openPicker) openPicker.close();
}

/** Anchor below the swatch, flipping above and clamping into the
 *  viewport when there isn't room (the modal's colour rows run right to
 *  the bottom of a short window). */
function position(el, anchorEl) {
  const a = anchorEl.getBoundingClientRect();
  const w = el.offsetWidth || 220;
  const h = el.offsetHeight || 240;
  const margin = 8;
  let top = a.bottom + 6;
  if (top + h > window.innerHeight - margin) {
    const above = a.top - 6 - h;
    top = above >= margin ? above : Math.max(margin, window.innerHeight - margin - h);
  }
  let left = a.left;
  if (left + w > window.innerWidth - margin) left = window.innerWidth - margin - w;
  el.style.left = `${Math.max(margin, left)}px`;
  el.style.top = `${Math.max(margin, top)}px`;
}

// ── input enhancement ─────────────────────────────────────────────────────

/**
 * Route every `input[type="color"]` under `root` through this picker,
 * including ones added later by a re-render. Returns a dispose function
 * that stops observing and closes any open popup (the enhanced inputs
 * themselves go away with the modal that owns them).
 */
export function installColorPickers(root) {
  if (!root) return () => {};
  enhanceAll(root);
  const observer = new MutationObserver((records) => {
    for (const rec of records) {
      for (const node of rec.addedNodes) {
        if (node.nodeType !== 1) continue;
        if (node.matches?.('input[type="color"]')) enhance(node);
        else enhanceAll(node);
      }
    }
  });
  observer.observe(root, { childList: true, subtree: true });
  return () => {
    observer.disconnect();
    closeColorPicker();
  };
}

function enhanceAll(root) {
  root.querySelectorAll?.('input[type="color"]').forEach(enhance);
}

function enhance(input) {
  if (input.dataset.hushColorPicker) return;
  input.dataset.hushColorPicker = "1";
  const well = document.createElement("span");
  well.className = "hush-color-well";
  input.parentNode.insertBefore(well, input);
  well.appendChild(input);
  // The native input paints the swatch but has no alpha channel to paint
  // *with*, so the well fades it over its own checkerboard instead. Kept
  // in step on every write, ours or a caller's.
  const syncWellAlpha = () => {
    const a = parseFloat(input.dataset.alpha);
    well.style.setProperty("--well-alpha", String(Number.isFinite(a) ? clamp(a, 0, 1) : 1));
  };
  syncWellAlpha();
  input.addEventListener("input", syncWellAlpha);
  input.addEventListener("change", syncWellAlpha);
  const hit = document.createElement("span");
  hit.className = "hush-color-well-hit";
  hit.setAttribute("role", "button");
  hit.tabIndex = 0;
  const label = input.closest(".style-editor-color-row, .style-editor-row")
    ?.querySelector("label")?.textContent?.trim();
  hit.setAttribute("aria-label", label ? `${label} colour` : "Choose colour");
  // The native input keeps painting the swatch but is out of the tab
  // order — focusing it would let a keyboard user open the platform
  // panel we just routed around.
  input.tabIndex = -1;
  well.appendChild(hit);
  const open = (e) => {
    if (input.disabled) return;
    e.preventDefault();
    e.stopPropagation();
    openColorPicker(input, well);
  };
  // pointerdown, not click: on iOS a tap that the system later claims
  // for scrolling never produces a click at all.
  hit.addEventListener("pointerdown", open);
  hit.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") open(e);
  });
}
