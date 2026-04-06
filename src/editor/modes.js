export function applyModes(state) {
  const app = document.getElementById("app");
  app.classList.toggle("ratchet-active", state.ratchetMode);
  app.classList.toggle("private-mode", state.privateMode);
  app.classList.toggle("typewriter-mode", state.typewriterMode);
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

export function updateColumnResizers(state) {
  document.querySelectorAll(".column-resizer").forEach((el) => el.remove());
  if (state._columnResizeHandler) {
    window.removeEventListener("resize", state._columnResizeHandler);
  }

  const leftResizer = document.createElement("div");
  leftResizer.className = "column-resizer left";
  const rightResizer = document.createElement("div");
  rightResizer.className = "column-resizer right";

  document.body.appendChild(leftResizer);
  document.body.appendChild(rightResizer);
  let hideTimeout = null;
  function showBoth() {
    clearTimeout(hideTimeout);
    leftResizer.classList.add("hover");
    rightResizer.classList.add("hover");
  }
  function hideBoth() {
    hideTimeout = setTimeout(() => {
      leftResizer.classList.remove("hover");
      rightResizer.classList.remove("hover");
    }, 200);
  }
  leftResizer.addEventListener("mouseenter", showBoth);
  leftResizer.addEventListener("mouseleave", hideBoth);
  rightResizer.addEventListener("mouseenter", showBoth);
  rightResizer.addEventListener("mouseleave", hideBoth);

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

    // When panels are inset and visible, center within remaining space
    let leftInsetOffset = 0;
    if (isInset && panelOpen) {
      leftInsetOffset = 350; // sidebar (50) + panel (300)
    }
    let rightInsetOffset = 0;
    if (rightInset && rightOpen) {
      rightInsetOffset = 200; // right panel (200)
    }

    const availableWidth = w - leftInsetOffset - rightInsetOffset;
    const basePad = Math.max(minPad, Math.floor((availableWidth - colW) / 2));
    const leftPad = basePad + leftInsetOffset;
    const rightPad = basePad + rightInsetOffset;
    const showResizers = availableWidth > colW + minPad * 2;
    const scroller = document.querySelector("#editor-container .cm-scroller");
    if (scroller) {
      scroller.style.paddingLeft = leftPad + "px";
      scroller.style.paddingRight = rightPad + "px";
    }
    if (state.editor && state.editor.view) state.editor.view.requestMeasure();
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
  }

  applyColumnLayout();
  state._columnResizeHandler = applyColumnLayout;
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
