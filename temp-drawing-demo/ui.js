/* ============================================================
 * ui.js — toolbar + brush-flyout DOM wiring (stamped).
 *
 * Knows nothing about strokes, selection, or slot state. Fires a
 * callback per control. The flyout panel is a shared element — the
 * script-level glue decides when to open/close it and which slot its
 * controls currently target.
 * ============================================================ */

export function createUI({
  // toolbar
  toolButtons,
  slotButtons,
  clearBtn,
  layersBtn,            // toolbar button that opens the layers flyout
  // flyouts
  flyoutPanel,          // brush flyout
  eraserPanel,          // eraser thickness mini-flyout
  layersPanel,          // layers flyout
  eraserSizeInput,
  eraserSizeVal,
  // sliders
  sizeInput, sizeVal,
  streamInput, streamVal,
  smoothInput, smoothVal,
  spacingInput, spacingVal,
  // brush grid (container; buttons are built here)
  brushGrid,
  brushes,              // [{id, name}] list from the engine
  // color swatches
  swatches,
  // mode toggle
  modeToggle,           // single pill switch element; 'highlighter' when on
  // callbacks
  onToolChange,
  onToolReclick,        // (tool) => void — same tool button tapped twice
  onSlotClick,          // (slotIndex) => void — glue decides activate + flyout
  onClear,
  onSizeChange,
  onSizeCommit,
  onStreamChange,
  onSmoothChange,
  onSpacingChange,
  onBrushChange,
  onColorChange,
  onModeChange,         // (mode: 'normal' | 'highlighter') => void
  onEraserSizeChange,
  onLayersToggle,        // () => void — called when the layers tool button is tapped
}) {
  let currentTool = 'draw';

  function setToolButtons(tool) {
    toolButtons.forEach((b) =>
      b.setAttribute('aria-pressed', b.dataset.tool === tool ? 'true' : 'false'),
    );
  }

  toolButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      const tool = btn.dataset.tool;
      if (tool === currentTool) {
        // Re-tap on the active tool button. Glue decides what to do (e.g.
        // open the eraser-thickness flyout when the eraser is re-tapped).
        onToolReclick && onToolReclick(tool);
        return;
      }
      currentTool = tool;
      setToolButtons(currentTool);
      onToolChange && onToolChange(currentTool);
    });
  });

  slotButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      const i = +btn.dataset.slot;
      onSlotClick && onSlotClick(i);
    });
  });

  function bindSlider(input, readout, handler) {
    if (!input) return;
    input.addEventListener('input', (e) => {
      const v = +e.target.value;
      if (readout) readout.textContent = e.target.value;
      handler && handler(v);
    });
    if (readout) readout.textContent = input.value;
  }

  bindSlider(sizeInput, sizeVal, (v) => onSizeChange && onSizeChange(v));
  // 'change' fires once when the user releases the slider — use it as the
  // commit boundary for the retroact-on-selection style session.
  if (sizeInput) {
    sizeInput.addEventListener('change', (e) => {
      onSizeCommit && onSizeCommit(+e.target.value);
    });
  }
  bindSlider(streamInput, streamVal, (v) => onStreamChange && onStreamChange(v / 100));
  bindSlider(smoothInput, smoothVal, (v) => onSmoothChange && onSmoothChange(v / 100));
  bindSlider(spacingInput, spacingVal, (v) => onSpacingChange && onSpacingChange(v));
  bindSlider(eraserSizeInput, eraserSizeVal, (v) => onEraserSizeChange && onEraserSizeChange(v));

  // Brush grid — one button per brush id, each holding its own thumbnail
  // canvas. The glue is responsible for painting the thumbnails (it has
  // access to the engine); this module just wires clicks and highlights.
  const brushGridCanvases = new Map();
  if (brushGrid && brushes) {
    brushGrid.innerHTML = '';
    for (const b of brushes) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'brush-opt';
      btn.dataset.brushId = b.id;
      btn.setAttribute('aria-checked', 'false');
      btn.setAttribute('aria-label', b.name);
      const c = document.createElement('canvas');
      c.className = 'brush-opt-thumb';
      c.width = 56;
      c.height = 56;
      btn.appendChild(c);
      btn.addEventListener('click', () => {
        setBrushGridState(b.id);
        onBrushChange && onBrushChange(b.id);
      });
      brushGrid.appendChild(btn);
      brushGridCanvases.set(b.id, c);
    }
  }

  function setBrushGridState(id) {
    if (!brushGrid) return;
    for (const btn of brushGrid.querySelectorAll('.brush-opt')) {
      btn.setAttribute('aria-checked', btn.dataset.brushId === id ? 'true' : 'false');
    }
  }

  // Color swatches inside the flyout.
  function setSwatchState(color) {
    swatches.forEach((s) =>
      s.setAttribute('aria-checked', s.dataset.color === color ? 'true' : 'false'),
    );
  }
  swatches.forEach((sw) => {
    sw.addEventListener('click', () => {
      const c = sw.dataset.color;
      setSwatchState(c);
      onColorChange && onColorChange(c);
    });
  });

  // Mode toggle — single pill switch. 'highlighter' when checked, 'normal'
  // otherwise. Glue decides whether to retroact on a selection or just
  // update the active slot's config.
  function setModeToggleState(mode) {
    if (!modeToggle) return;
    modeToggle.setAttribute('aria-checked', mode === 'highlighter' ? 'true' : 'false');
  }
  if (modeToggle) {
    modeToggle.addEventListener('click', () => {
      const next = modeToggle.getAttribute('aria-checked') === 'true' ? 'normal' : 'highlighter';
      setModeToggleState(next);
      onModeChange && onModeChange(next);
    });
  }

  clearBtn.addEventListener('click', () => {
    onClear && onClear();
  });

  // Flyout state — open/close is driven by the glue via the returned
  // setFlyout()/setEraserPanel() helpers. Clicks outside the panel +
  // its associated trigger close it. Both flyouts are independent but
  // mutually exclusive (open one closes the other).
  let flyoutOpen = false;
  let eraserPanelOpen = false;
  let layersPanelOpen = false;
  const outsidePointerHandlers = new Set();
  function setFlyout(open) {
    if (open && eraserPanelOpen) setEraserPanel(false);
    if (open && layersPanelOpen) setLayersPanel(false);
    flyoutOpen = open;
    if (!flyoutPanel) return;
    flyoutPanel.classList.toggle('open', open);
    flyoutPanel.setAttribute('aria-hidden', open ? 'false' : 'true');
  }
  function setEraserPanel(open) {
    if (open && flyoutOpen) setFlyout(false);
    if (open && layersPanelOpen) setLayersPanel(false);
    eraserPanelOpen = open;
    if (!eraserPanel) return;
    eraserPanel.classList.toggle('open', open);
    eraserPanel.setAttribute('aria-hidden', open ? 'false' : 'true');
  }
  function setLayersPanel(open) {
    if (open && flyoutOpen) setFlyout(false);
    if (open && eraserPanelOpen) setEraserPanel(false);
    layersPanelOpen = open;
    if (layersBtn) layersBtn.setAttribute('aria-pressed', open ? 'true' : 'false');
    if (!layersPanel) return;
    layersPanel.classList.toggle('open', open);
    layersPanel.setAttribute('aria-hidden', open ? 'false' : 'true');
  }
  function isEraserTrigger(el) {
    for (const b of toolButtons) {
      if ((b.dataset.tool === 'erase' || b.dataset.tool === 'slice') && b.contains(el)) {
        return true;
      }
    }
    return false;
  }
  document.addEventListener('pointerdown', (e) => {
    if (flyoutOpen) {
      const inPanel = flyoutPanel && flyoutPanel.contains(e.target);
      let inSlot = false;
      for (const b of slotButtons) if (b.contains(e.target)) { inSlot = true; break; }
      if (!inPanel && !inSlot) {
        setFlyout(false);
        for (const h of outsidePointerHandlers) h();
      }
    }
    if (eraserPanelOpen) {
      const inPanel = eraserPanel && eraserPanel.contains(e.target);
      if (!inPanel && !isEraserTrigger(e.target)) {
        setEraserPanel(false);
      }
    }
    if (layersPanelOpen) {
      const inPanel = layersPanel && layersPanel.contains(e.target);
      const onTrigger = layersBtn && layersBtn.contains(e.target);
      if (!inPanel && !onTrigger) {
        setLayersPanel(false);
      }
    }
  }, true);

  if (layersBtn) {
    layersBtn.addEventListener('click', () => {
      if (onLayersToggle) onLayersToggle();
    });
  }

  function setActiveSlot(i) {
    slotButtons.forEach((b) => {
      b.setAttribute('aria-pressed', +b.dataset.slot === i ? 'true' : 'false');
    });
  }

  // Push values from a slot config into the flyout controls without firing
  // any change callbacks. Called by the glue whenever the active slot
  // changes, so sliders/swatches/brush select reflect the newly-active slot.
  function setFlyoutValues(cfg) {
    if (sizeInput) {
      sizeInput.value = cfg.size;
      if (sizeVal) sizeVal.textContent = String(cfg.size);
    }
    if (streamInput) {
      const v = Math.round(cfg.streamline * 100);
      streamInput.value = v;
      if (streamVal) streamVal.textContent = String(v);
    }
    if (smoothInput) {
      const v = Math.round(cfg.smoothing * 100);
      smoothInput.value = v;
      if (smoothVal) smoothVal.textContent = String(v);
    }
    if (spacingInput) {
      const v = Math.round(cfg.spacing * 100);
      spacingInput.value = v;
      if (spacingVal) spacingVal.textContent = String(v);
    }
    setBrushGridState(cfg.brushId);
    setSwatchState(cfg.color);
    setModeToggleState(cfg.mode || 'normal');
  }

  return {
    setTool(tool) {
      currentTool = tool;
      setToolButtons(tool);
    },
    setActiveSlot,
    setFlyoutValues,
    // Reset just the color swatch state — used by the glue to back out the
    // swatch highlight when a click got consumed by a retroactive session.
    setColorSwatch: setSwatchState,
    setBrushGridState,
    setModeToggle: setModeToggleState,
    getBrushCanvas(id) { return brushGridCanvases.get(id); },
    openFlyout() { setFlyout(true); },
    closeFlyout() { setFlyout(false); },
    toggleFlyout() { setFlyout(!flyoutOpen); },
    isFlyoutOpen() { return flyoutOpen; },
    openEraserPanel() { setEraserPanel(true); },
    closeEraserPanel() { setEraserPanel(false); },
    toggleEraserPanel() { setEraserPanel(!eraserPanelOpen); },
    isEraserPanelOpen() { return eraserPanelOpen; },
    openLayersPanel() { setLayersPanel(true); },
    closeLayersPanel() { setLayersPanel(false); },
    toggleLayersPanel() { setLayersPanel(!layersPanelOpen); },
    isLayersPanelOpen() { return layersPanelOpen; },
    setEraserSize(n) {
      if (eraserSizeInput) eraserSizeInput.value = String(n);
      if (eraserSizeVal) eraserSizeVal.textContent = String(n);
    },
    onOutsideClose(fn) { outsidePointerHandlers.add(fn); },
  };
}
