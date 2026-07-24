/**
 * Per-Desktop options — the extra section the Desktop injects into the
 * canvas's background-settings flyout (bg-settings-popup.ts renders it
 * through `DrawingState.extraBgSettingsSection`):
 *
 *   - Doc text size      slider 3–12 (doc thumbnails re-render)
 *   - Thumbnail long edge slider 200–800 in 100 px steps
 *   - Thumbnail labels   on/off
 *   - Include Gutters    on/off (default off)
 *
 * Values persist per container inside the Desktop envelope
 * (desktop-store.js). The section builder is pure DOM — desktop-view
 * owns the option state and effects via the callbacks.
 */

export const DESKTOP_OPTION_DEFAULTS = {
  docFontSize: 8,
  thumbLongEdge: 400,
  showLabels: true,
  includeGutters: false,
};

export function normalizeDesktopOptions(raw) {
  const o = { ...DESKTOP_OPTION_DEFAULTS, ...(raw && typeof raw === "object" ? raw : {}) };
  o.docFontSize = Math.min(12, Math.max(3, Math.round(o.docFontSize) || 8));
  o.thumbLongEdge = Math.min(800, Math.max(200, Math.round((o.thumbLongEdge || 400) / 100) * 100));
  o.showLabels = o.showLabels !== false;
  o.includeGutters = o.includeGutters === true;
  return o;
}

function el(tag, style, text) {
  const node = document.createElement(tag);
  if (style) Object.assign(node.style, style);
  if (text != null) node.textContent = text;
  return node;
}

/** Build the flyout section. `getOptions()` returns the live option
 *  object; `setOption(key, value)` applies + persists it. `theme` is
 *  the canvas theme (for popup-consistent styling). */
export function buildDesktopOptionsSection(theme, getOptions, setOption) {
  const o = getOptions();
  const wrap = el("div", { marginTop: "12px", paddingTop: "10px", borderTop: `1px solid ${theme.uiBorder}` });
  const labelStyle = {
    fontSize: "11px", fontWeight: "600", color: theme.foreground,
    marginBottom: "6px", opacity: "0.7",
  };
  wrap.appendChild(el("div", { ...labelStyle, opacity: "0.9" }, "Desktop"));

  const sliderRow = (label, { min, max, step, value, format, onInput }) => {
    wrap.appendChild(el("div", labelStyle, label));
    const row = el("div", { display: "flex", alignItems: "center", gap: "6px", marginBottom: "10px" });
    const input = document.createElement("input");
    input.type = "range";
    input.min = String(min); input.max = String(max); input.step = String(step);
    input.value = String(value);
    Object.assign(input.style, { flex: "1", accentColor: theme.accent });
    const valueEl = el("span", {
      fontSize: "11px", color: theme.foreground, opacity: "0.6",
      minWidth: "38px", textAlign: "right",
    }, format(value));
    input.addEventListener("input", () => {
      const v = parseInt(input.value, 10);
      valueEl.textContent = format(v);
      onInput(v);
    });
    row.appendChild(input);
    row.appendChild(valueEl);
    wrap.appendChild(row);
  };

  sliderRow("Doc text size", {
    min: 3, max: 12, step: 1, value: o.docFontSize,
    format: (v) => `${v}px`,
    onInput: (v) => setOption("docFontSize", v),
  });
  sliderRow("Thumbnail long edge", {
    min: 200, max: 800, step: 100, value: o.thumbLongEdge,
    format: (v) => `${v}px`,
    onInput: (v) => setOption("thumbLongEdge", v),
  });

  const toggleRow = (label, value, onToggle) => {
    const row = el("div", { display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px", marginBottom: "8px" });
    row.appendChild(el("span", { fontSize: "11px", fontWeight: "600", color: theme.foreground, opacity: "0.7" }, label));
    const btn = document.createElement("button");
    const paint = (on) => {
      btn.textContent = on ? "On" : "Off";
      Object.assign(btn.style, {
        padding: "2px 10px", borderRadius: "4px", cursor: "pointer",
        fontFamily: "inherit", fontSize: "11px",
        border: `1px solid ${on ? theme.accent : theme.uiBorder}`,
        background: on ? theme.accent : "transparent",
        color: on ? "#fff" : theme.foreground,
        fontWeight: on ? "600" : "400",
      });
    };
    paint(value);
    btn.addEventListener("click", () => {
      const next = !(btn.textContent === "On");
      paint(next);
      onToggle(next);
    });
    row.appendChild(btn);
    wrap.appendChild(row);
  };

  toggleRow("Thumbnail labels", o.showLabels, (v) => setOption("showLabels", v));
  toggleRow("Include Gutters", o.includeGutters, (v) => setOption("includeGutters", v));

  return wrap;
}
