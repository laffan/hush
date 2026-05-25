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
    }

    const availableWidth = w - leftInsetOffset - rightInsetOffset;
    let leftPad, rightPad;

    // "Make space for panes": when a doc pane is visible in this context,
    // push the column away from the panes per the user's chosen direction.
    const makeSpace = state.settings.makeSpaceForPanes !== false;
    const direction = state.settings.makeSpaceDirection === "left" ? "left" : "right";
    const hasDocPane = !!state.runtime.hasVisibleDocPane;
    const makeSpaceActive = makeSpace && hasDocPane && !state.currentNotebookFileId && availableWidth > colW + minPad * 2;
    if (makeSpaceActive) {
      // Allow the user to drag the column horizontally. The persisted
      // offset is clamped against the remaining slack so the column
      // can't slide off-screen or under the pane.
      const slack = availableWidth - colW - minPad * 2;
      const rawOff = Number(state.settings.makeSpaceColumnOffset || 0);
      const off = Math.max(0, Math.min(slack, rawOff));
      if (direction === "left") {
        leftPad = minPad + leftInsetOffset + off;
        rightPad = w - colW - leftPad;
      } else {
        rightPad = minPad + rightInsetOffset + off;
        leftPad = w - colW - rightPad;
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
      // 50vh bottom pad for plain docs so the last line can scroll to
      // approximately the vertical centre of the screen. Skip in
      // projects (extra space between concatenated docs would read as
      // a gap) and in notebook mode (no scroller there anyway).
      // When typewriter mode is active its own paddingBottom
      // calculation overrides this value.
      const isPlainDoc = !state.currentNotebookFileId && !state.currentProjectId;
      scroller.style.paddingBottom = isPlainDoc ? "50vh" : "";
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
    requestAnimationFrame(tick);
  }

  tick();
}
