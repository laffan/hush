import { applyTypewriterPadding } from "./plugins/typewriter.js";

/**
 * Set vertical padding on the editor's scroller.
 *
 * The scroller only carries the top / bottom insets that docked panes
 * carve out of the editor column — content otherwise starts at the top
 * and scrolls normally (no scroll-to-centre padding).
 *
 * When typewriter mode owns the editor we defer to its own padding
 * routine, which pins the cursor line to the typewriter boundary.
 * Notebook surfaces have no scroller and are left alone.
 */
export function applyEditorScrollerPadding(state, opts = {}) {
  const scroller = document.querySelector("#editor-container .cm-scroller");
  if (!scroller) return;
  const topInset = opts.topInset ?? (state.runtime.dockedTopHeight || 0);
  const bottomInset = opts.bottomInset ?? (state.runtime.dockedBottomHeight || 0);

  if (state.typewriterMode && state.editor?.view) {
    // Typewriter manages both paddings to pin the cursor line to the
    // boundary. Honour any top/bottom dock insets that have appeared
    // since typewriter mode was first set up.
    applyTypewriterPadding(state.editor.view, state);
    return;
  }

  scroller.style.paddingTop = topInset > 0 ? topInset + "px" : "";
  scroller.style.paddingBottom = bottomInset > 0 ? bottomInset + "px" : "";
}

export function applyModes(state) {
  const app = document.getElementById("app");
  app.classList.toggle("ratchet-active", state.ratchetMode);
  app.classList.toggle("private-mode", state.privateMode);
  app.classList.toggle("typewriter-mode", state.typewriterMode);
  // Focus mode lives on <body> so floating panes (which are siblings of
  // #app, not children) can pick it up via a CSS selector and dim along
  // with the editor.
  document.body.classList.toggle("focus-mode-active", state.focusMode);
  // Dummy mode neutralizes heading styles so the dummy text looks like plain prose
  const isDummy = state.privateMode && (state.settings.privacyMode === "dummy");
  app.classList.toggle("dummy-mode", isDummy);
}

export async function applyFullscreen(state) {
  const app = document.getElementById("app");
  app.classList.toggle("fullscreen-mode", state.isFullscreen);

  const IS_TAURI = typeof window !== "undefined" && window.__TAURI_INTERNALS__;
  if (IS_TAURI) {
    try {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      const { invoke } = await import("@tauri-apps/api/core");
      const win = getCurrentWindow();

      // Switch to Regular activation policy so macOS shows our menu bar in fullscreen
      if (state.isFullscreen) {
        await invoke("set_activation_policy", { policy: "regular" });
      }

      try {
        await win.setSimpleFullscreen(state.isFullscreen);
      } catch (_) {
        await win.setFullscreen(state.isFullscreen);
      }

      if (!state.isFullscreen) {
        // Restore activation policy based on visibility setting
        const vis = state.settings.visibility;
        if (vis !== "dock" && vis !== "both") {
          await invoke("set_activation_policy", { policy: "accessory" });
        }
        // Apply always-on-top based on user setting
        await invoke("set_always_on_top", { onTop: !!state.settings.alwaysOnTop });
      }
      // Re-focus window after fullscreen transition in both directions
      await win.setFocus();
    } catch (e) {
      console.error("Fullscreen toggle failed:", e);
    }
  }

  updateColumnResizers(state);
}

/** Read --panel-width from the root element, falling back to 300. */
export function getPanelWidthPx() {
  const v = getComputedStyle(document.documentElement).getPropertyValue("--panel-width").trim();
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : 300;
}

export function updateColumnResizers(state) {
  document.querySelectorAll(".column-resizer").forEach((el) => el.remove());
  document.querySelectorAll(".column-mover").forEach((el) => el.remove());
  if (state.runtime.columnResizeHandler) {
    window.removeEventListener("resize", state.runtime.columnResizeHandler);
  }
  if (state.runtime.dockChangedHandler) {
    document.removeEventListener("pane-dock-changed", state.runtime.dockChangedHandler);
  }

  const leftResizer = document.createElement("div");
  leftResizer.className = "column-resizer left";
  const rightResizer = document.createElement("div");
  rightResizer.className = "column-resizer right";
  // Mover handles — a pair that surfaces only while the "Make space
  // for panes" layout is engaged (doc + a visible pane). One sits
  // *outside* each column resizer; either can be dragged horizontally
  // to slide the column without changing its width.
  const moverLeft = document.createElement("div");
  moverLeft.className = "column-mover left";
  moverLeft.title = "Drag to reposition column";
  const moverRight = document.createElement("div");
  moverRight.className = "column-mover right";
  moverRight.title = "Drag to reposition column";

  document.body.appendChild(leftResizer);
  document.body.appendChild(rightResizer);
  document.body.appendChild(moverLeft);
  document.body.appendChild(moverRight);
  let hideTimeout = null;
  function showBoth() {
    clearTimeout(hideTimeout);
    leftResizer.classList.add("hover");
    rightResizer.classList.add("hover");
    // Surface the mover handles alongside the resize bars — the user
    // sees both means of repositioning together rather than discovering
    // the small movers separately.
    moverLeft.classList.add("hover");
    moverRight.classList.add("hover");
  }
  function hideBoth() {
    hideTimeout = setTimeout(() => {
      leftResizer.classList.remove("hover");
      rightResizer.classList.remove("hover");
      moverLeft.classList.remove("hover");
      moverRight.classList.remove("hover");
    }, 200);
  }
  leftResizer.addEventListener("mouseenter", showBoth);
  leftResizer.addEventListener("mouseleave", hideBoth);
  rightResizer.addEventListener("mouseenter", showBoth);
  rightResizer.addEventListener("mouseleave", hideBoth);
  // Hovering either mover keeps the entire affordance set visible —
  // moving between a resize bar and a mover (or back) never blinks
  // the chrome on or off.
  moverLeft.addEventListener("mouseenter", showBoth);
  moverLeft.addEventListener("mouseleave", hideBoth);
  moverRight.addEventListener("mouseenter", showBoth);
  moverRight.addEventListener("mouseleave", hideBoth);

  function applyColumnLayout() {
    const w = window.innerWidth;
    const colW = state.settings.columnWidth;
    const minPad = 50;

    // Check if left sidebar/panel is occupying inset space
    const panelEl = document.getElementById("panel-overlay");
    const isInset = panelEl && panelEl.classList.contains("panel-inset");
    const panelOpen = panelEl && !panelEl.classList.contains("hidden");

    // Check if right panel is occupying inset space
    const rightPanelEl = document.getElementById("right-panel-overlay");
    const rightInset = rightPanelEl && rightPanelEl.classList.contains("panel-inset");
    const rightOpen = rightPanelEl && !rightPanelEl.classList.contains("hidden");

    // When panels are inset and visible, center within remaining space.
    // Panel width is user-resizable; read it from the CSS var.
    // The grip strip stays visible even when the panel body is hidden,
    // so always carve out at least its width on inset layouts.
    let leftInsetOffset = 0;
    if (isInset) {
      const gripRaw = getComputedStyle(document.documentElement).getPropertyValue("--sidebar-grip-width").trim();
      const gripW = parseInt(gripRaw, 10) || 24;
      leftInsetOffset = panelOpen ? getPanelWidthPx() : gripW;
    }
    let rightInsetOffset = 0;
    if (rightInset && rightOpen) {
      rightInsetOffset = 200; // right panel (200)
      // The comments panel is pinned to the outline's left edge; when it's
      // showing it carves out its own width too, so the column is pushed in
      // rather than overlaid (matches its CSS width).
      const commentsEl = document.getElementById("comments-panel");
      if (commentsEl && !commentsEl.classList.contains("hidden")) {
        rightInsetOffset += 240;
      }
    }

    // Docked panes carve out additional space the editor column must
    // not overlap. Stack with whatever chrome insets are already in
    // play so a left-docked pane sitting beside an open sidebar still
    // leaves the column properly contained.
    leftInsetOffset += state.runtime.dockedLeftWidth || 0;
    rightInsetOffset += state.runtime.dockedRightWidth || 0;
    // Top/bottom docks shrink the editor vertically the same way as if
    // the window had shortened. The scroller is the only mounted CM
    // surface that pads symmetrically, so we apply matching paddingTop
    // / paddingBottom further down — and offset the column resizers'
    // top / bottom rails too so they don't run behind the dock.
    const topInsetOffset = state.runtime.dockedTopHeight || 0;
    const bottomInsetOffset = state.runtime.dockedBottomHeight || 0;

    const availableWidth = w - leftInsetOffset - rightInsetOffset;
    let leftPad, rightPad;

    // Make-space-for-panes is automatic: always on when a single pane
    // is visible. With one pane, shift the column away from the side
    // that pane sits on (compare centroid to viewport mid). With zero
    // or 2+ panes, center the column — multi-pane layouts vary too
    // much to auto-choose, so leave it neutral and let the user drag.
    const visiblePaneCount = state.runtime.visiblePaneCount || 0;
    const centroid = state.runtime.visiblePaneCentroid;
    const makeSpaceActive = visiblePaneCount === 1 && !state.currentNotebookFileId && availableWidth > colW + minPad * 2;
    if (makeSpaceActive) {
      const slack = availableWidth - colW - minPad * 2;
      const rawOff = Number(state.settings.makeSpaceColumnOffset || 0);
      const off = Math.max(0, Math.min(slack, rawOff));
      const viewportMid = leftInsetOffset + (w - leftInsetOffset - rightInsetOffset) / 2;
      const paneOnLeft = centroid !== null && centroid < viewportMid;
      if (paneOnLeft) {
        rightPad = minPad + rightInsetOffset + off;
        leftPad = w - colW - rightPad;
      } else {
        leftPad = minPad + leftInsetOffset + off;
        rightPad = w - colW - leftPad;
      }
    } else {
      const basePad = Math.max(minPad, Math.floor((availableWidth - colW) / 2));
      leftPad = basePad + leftInsetOffset;
      rightPad = basePad + rightInsetOffset;
    }
    const showResizers = availableWidth > colW + minPad * 2;
    const scroller = document.querySelector("#editor-container .cm-scroller");
    if (scroller) {
      scroller.style.paddingLeft = leftPad + "px";
      scroller.style.paddingRight = rightPad + "px";
      // Vertical padding is split out — typewriter mode owns the
      // scroller's top/bottom pads when active, and short docs need
      // dynamic top padding so the last line can still reach the
      // vertical centre via scrolling.
      applyEditorScrollerPadding(state, { topInset: topInsetOffset, bottomInset: bottomInsetOffset });
    }
    if (state.editor && state.editor.view) {
      // requestMeasure alone is not always enough after padding changes
      // — WebKit caches the painted layer with the old line geometry,
      // so scrolling reveals fragments of text at the previous wrap
      // positions for a few seconds before the next viewport refresh
      // forces a repaint. Dispatching a no-op transaction triggers a
      // full viewport rebuild (CM treats it as a doc-change-like
      // update) which forces the surrounding layer to invalidate now.
      state.editor.view.dispatch({});
      state.editor.view.requestMeasure();
    }
    state.emit("layout-changed");

    if (showResizers) {
      leftResizer.style.display = "";
      rightResizer.style.display = "";
      leftResizer.style.left = (leftPad - 10) + "px";
      rightResizer.style.left = (w - rightPad + 10) + "px";
      // Clip the rails so they don't run behind top / bottom docks —
      // the dock is opaque and the resizer's hover stripe would peek
      // out otherwise.
      leftResizer.style.top = topInsetOffset + "px";
      leftResizer.style.bottom = bottomInsetOffset + "px";
      rightResizer.style.top = topInsetOffset + "px";
      rightResizer.style.bottom = bottomInsetOffset + "px";
    } else {
      leftResizer.style.display = "none";
      rightResizer.style.display = "none";
    }

    // Mover handles — only meaningful when the make-space layout is
    // active. One sits vertically centred *outside* each column
    // resizer (5 px gap to the resizer rail). Reveal follows the
    // resizers' cmd-held rule via CSS so they stay invisible during
    // normal writing.
    if (makeSpaceActive && showResizers) {
      moverLeft.style.display = "";
      moverRight.style.display = "";
      // The column-resizer renders with `margin-left: -20px` (CSS), so
      // an element whose `style.left = leftPad - 10` actually paints
      // its box at `leftPad - 30`. The visible 3 px stripe lives on
      // a `::after` at `left: 19px` inside that box, which means:
      //   left rail visible at:  leftPad - 30 + 19 = leftPad - 11
      //   right rail visible at: (w - rightPad - 10) + 19 = w - rightPad + 9
      // with rail width 3 px. The movers sit 5 px outside those rails.
      const handleWidth = 14;
      const gap = 5;
      const railThickness = 3;
      const HANDLE_HEIGHT = 40;
      const leftRailLeft = leftPad - 11;
      const rightRailRight = (w - rightPad) + 9 + railThickness;
      moverLeft.style.left = (leftRailLeft - gap - handleWidth) + "px";
      moverRight.style.left = (rightRailRight + gap) + "px";
      moverLeft.style.top = `calc(50% - ${HANDLE_HEIGHT / 2}px)`;
      moverRight.style.top = `calc(50% - ${HANDLE_HEIGHT / 2}px)`;
    } else {
      moverLeft.style.display = "none";
      moverRight.style.display = "none";
    }
  }

  applyColumnLayout();
  state.runtime.columnResizeHandler = applyColumnLayout;
  window.addEventListener("resize", applyColumnLayout);
  // `dockPane` schedules `refreshPaneLayoutMetrics` through a lazy
  // import to dodge a circular dependency, which means the editor's
  // `state.runtime.docked*` values can lag behind the actual dock —
  // the column then paints under a freshly-docked right pane until
  // the promise resolves. `publishDockCssVars` fires
  // `pane-dock-changed` synchronously after writing the new CSS
  // vars, so picking up its detail here closes that gap.
  const onDockChanged = (e) => {
    const d = e.detail || {};
    state.runtime.dockedLeftWidth = d.leftWidth || 0;
    state.runtime.dockedRightWidth = d.rightWidth || 0;
    state.runtime.dockedTopHeight = d.topHeight || 0;
    state.runtime.dockedBottomHeight = d.bottomHeight || 0;
    applyColumnLayout();
  };
  document.addEventListener("pane-dock-changed", onDockChanged);
  state.runtime.dockChangedHandler = onDockChanged;

  function makeDraggable(el, isLeft) {
    let startX, startWidth;
    el.addEventListener("mousedown", (e) => {
      e.preventDefault();
      startX = e.clientX;
      startWidth = state.settings.columnWidth;
      el.classList.add("dragging");
      showBoth();

      function onMove(e2) {
        const delta = isLeft ? startX - e2.clientX : e2.clientX - startX;
        const newWidth = Math.max(300, Math.min(window.innerWidth - 100, startWidth + delta * 2));
        state.settings.columnWidth = newWidth;
        applyColumnLayout();
      }

      function onUp() {
        el.classList.remove("dragging");
        hideBoth();
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        state.updateSettings({ columnWidth: state.settings.columnWidth });
      }

      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    });
  }

  makeDraggable(leftResizer, true);
  makeDraggable(rightResizer, false);

  // Mover drag — slide the column horizontally without changing width.
  // Either handle drives the same offset; the "right" make-space
  // direction inverts the sign so dragging right always slides the
  // column right.
  function installMoverDrag(handle) {
    handle.addEventListener("mousedown", (e) => {
      e.preventDefault();
      const direction = state.settings.makeSpaceDirection === "left" ? "left" : "right";
      const startX = e.clientX;
      const startOffset = Number(state.settings.makeSpaceColumnOffset || 0);
      handle.classList.add("dragging");

      function onMove(e2) {
        const delta = e2.clientX - startX;
        const signed = direction === "right" ? -delta : delta;
        state.settings.makeSpaceColumnOffset = Math.max(0, startOffset + signed);
        if (state.runtime.columnResizeHandler) state.runtime.columnResizeHandler();
      }
      function onUp() {
        handle.classList.remove("dragging");
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        state.updateSettings({ makeSpaceColumnOffset: state.settings.makeSpaceColumnOffset });
      }
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    });
  }
  installMoverDrag(moverLeft);
  installMoverDrag(moverRight);
}

export function updateRatchetTimer(state) {
  let timerEl = document.querySelector(".ratchet-timer");

  if (!state.ratchetMode) {
    if (timerEl) timerEl.remove();
    return;
  }

  if (!timerEl) {
    timerEl = document.createElement("div");
    timerEl.className = "ratchet-timer";
    document.body.appendChild(timerEl);
  }

  function tick() {
    if (!state.ratchetMode || !state.ratchetEndTime) {
      timerEl.remove();
      return;
    }
    const remaining = Math.max(0, state.ratchetEndTime - Date.now());
    if (remaining <= 0) {
      state.stopRatchet();
      timerEl.remove();
      return;
    }
    const mins = Math.floor(remaining / 60000);
    const secs = Math.floor((remaining % 60000) / 1000);
    timerEl.textContent = `${mins}:${secs.toString().padStart(2, "0")}`;
    // The display only changes once per second, so wake exactly on the
    // next second boundary instead of burning a 60 fps rAF loop on a
    // clock. Aligning to the boundary keeps the countdown visually crisp.
    setTimeout(tick, remaining % 1000 || 1000);
  }

  tick();
}
