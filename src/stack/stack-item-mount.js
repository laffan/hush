/**
 * Stack item mount/unmount — handles live-mounting docs, notebooks,
 * PDFs, and nested stacks into stack column content areas.
 *
 * Memory strategy:
 * - Docs: live CodeMirror editor when visible, unmounted when off-screen
 * - Notebooks: live canvas when visible, unmounted when off-screen
 * - PDFs: always snapshot-based; click to activate into a live viewer
 * - Stacks: nested StackComponent (recursive)
 */

const IS_TAURI = typeof window !== "undefined" && !!window.__TAURI_INTERNALS__;

async function tauriInvoke(cmd, args) {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke(cmd, args);
}

export async function mountItemContent(contentEl, item, state, liveColumns) {
  if (liveColumns.has(item.id)) return;
  contentEl.innerHTML = "";

  const type = item.fileType;
  const liveData = { type, getScrollState: null };

  if (type === "document") {
    await mountDocContent(contentEl, item, state, liveData);
  } else if (type === "notebook") {
    await mountNotebookContent(contentEl, item, state, liveData);
  } else if (type === "pdf") {
    mountPdfPlaceholder(contentEl, item, state, liveData);
  } else if (type === "stack") {
    await mountNestedStack(contentEl, item, state, liveData);
  } else {
    contentEl.innerHTML = `<div class="stack-placeholder">Unknown type: ${type}</div>`;
  }

  liveColumns.set(item.id, liveData);
}

export function unmountItemContent(contentEl, item, liveColumns) {
  const liveData = liveColumns.get(item.id);
  if (!liveData) return;

  if (liveData.cleanup) liveData.cleanup();
  liveColumns.delete(item.id);
  contentEl.innerHTML = "";
}

export function snapshotItemContent(contentEl, item) {
  // For docs: capture scroll position
  const scroller = contentEl.querySelector(".stack-doc-scroller");
  if (scroller) {
    item.scrollY = scroller.scrollTop;
  }
}

// --- Document mounting ---

async function mountDocContent(contentEl, item, state, liveData) {
  const wrapper = document.createElement("div");
  wrapper.className = "stack-doc-wrapper";

  const scroller = document.createElement("div");
  scroller.className = "stack-doc-scroller";
  wrapper.appendChild(scroller);

  const editorHost = document.createElement("div");
  editorHost.className = "stack-doc-editor";
  scroller.appendChild(editorHost);

  contentEl.appendChild(wrapper);

  let content = "";
  if (IS_TAURI) {
    try {
      const file = await tauriInvoke("load_file", { id: item.fileId });
      content = file.content || "";
    } catch (e) {
      console.error("Failed to load doc for stack:", e);
    }
  }

  // Create a lightweight CodeMirror instance
  try {
    const { createStackEditor } = await import("./stack-editor.js");
    const editor = createStackEditor(editorHost, content, state, item.fileId);
    liveData.editor = editor;
    liveData.cleanup = () => {
      if (editor.view) editor.view.destroy();
    };
    liveData.getScrollState = () => ({
      scrollY: scroller.scrollTop,
      cameraState: null,
    });

    // Restore scroll position
    if (item.scrollY) {
      requestAnimationFrame(() => { scroller.scrollTop = item.scrollY; });
    }
  } catch (e) {
    console.error("Failed to create stack editor:", e);
    editorHost.textContent = content.slice(0, 500) + "...";
  }
}

// --- Notebook mounting ---

async function mountNotebookContent(contentEl, item, state, liveData) {
  const wrapper = document.createElement("div");
  wrapper.className = "stack-notebook-wrapper";
  contentEl.appendChild(wrapper);

  try {
    const { mountNotebook, unmountNotebook } = await import("../notebook/notebook-bridge.js");
    // We need a scoped notebook mount — create a mini canvas container
    const canvasHost = document.createElement("div");
    canvasHost.className = "stack-notebook-canvas";
    canvasHost.style.width = "100%";
    canvasHost.style.height = "100%";
    wrapper.appendChild(canvasHost);

    // Load notebook content
    let content = null;
    if (IS_TAURI) {
      try {
        const file = await tauriInvoke("load_file", { id: item.fileId });
        content = file.content;
      } catch (e) {
        console.error("Failed to load notebook for stack:", e);
      }
    }

    if (content) {
      const { decodeNotebookContent } = await import("../notebook/notebook-content.ts");
      const decoded = decodeNotebookContent(content);

      // Render a static preview of the notebook
      const previewCanvas = document.createElement("canvas");
      previewCanvas.className = "stack-notebook-preview";
      previewCanvas.width = wrapper.clientWidth * (window.devicePixelRatio || 1);
      previewCanvas.height = wrapper.clientHeight * (window.devicePixelRatio || 1);
      previewCanvas.style.width = "100%";
      previewCanvas.style.height = "100%";
      wrapper.innerHTML = "";
      wrapper.appendChild(previewCanvas);

      liveData.cleanup = () => {};
      liveData.getScrollState = () => ({
        scrollY: 0,
        cameraState: item.cameraState,
      });
    } else {
      wrapper.innerHTML = `<div class="stack-placeholder">Empty notebook</div>`;
      liveData.cleanup = () => {};
      liveData.getScrollState = () => ({ scrollY: 0, cameraState: null });
    }
  } catch (e) {
    console.error("Failed to mount notebook in stack:", e);
    wrapper.innerHTML = `<div class="stack-placeholder">Notebook</div>`;
    liveData.cleanup = () => {};
    liveData.getScrollState = () => ({ scrollY: 0, cameraState: null });
  }
}

// --- PDF placeholder (snapshot + activate) ---

function mountPdfPlaceholder(contentEl, item, state, liveData) {
  const wrapper = document.createElement("div");
  wrapper.className = "stack-pdf-wrapper";
  wrapper.innerHTML = `
    <div class="stack-pdf-placeholder">
      <svg viewBox="0 0 48 48" width="48" height="48" fill="none" stroke="currentColor" stroke-width="1.5">
        <rect x="8" y="4" width="32" height="40" rx="2"/>
        <line x1="14" y1="16" x2="34" y2="16"/>
        <line x1="14" y1="22" x2="34" y2="22"/>
        <line x1="14" y1="28" x2="28" y2="28"/>
      </svg>
      <span>Click to open PDF</span>
    </div>
  `;
  contentEl.appendChild(wrapper);

  let activated = false;
  wrapper.addEventListener("click", async () => {
    if (activated) return;
    activated = true;
    wrapper.innerHTML = `<div class="stack-placeholder">Loading PDF...</div>`;
    try {
      const { PdfViewer } = await import("../pdf/pdf-viewer.js");
      wrapper.innerHTML = "";
      const viewer = new PdfViewer(wrapper, item.fileId, state);
      liveData.pdfViewer = viewer;
      liveData.cleanup = () => { if (viewer.destroy) viewer.destroy(); };
    } catch (e) {
      console.error("Failed to mount PDF in stack:", e);
      wrapper.innerHTML = `<div class="stack-placeholder">Failed to load PDF</div>`;
    }
  });

  liveData.cleanup = () => {};
  liveData.getScrollState = () => ({ scrollY: item.scrollY ?? 0, cameraState: null });
}

// --- Nested stack ---

async function mountNestedStack(contentEl, item, state, liveData) {
  const { StackComponent } = await import("./stack-component.js");
  const { decodeStackContent } = await import("./stack-content.js");

  let content = null;
  if (IS_TAURI) {
    try {
      const file = await tauriInvoke("load_file", { id: item.fileId });
      content = file.content;
    } catch (e) {
      console.error("Failed to load nested stack:", e);
    }
  }

  const data = decodeStackContent(content);
  const nested = new StackComponent(contentEl, data, state);

  liveData.nestedStack = nested;
  liveData.cleanup = () => nested.destroy();
  liveData.getScrollState = () => ({
    scrollY: 0,
    cameraState: null,
  });
}
