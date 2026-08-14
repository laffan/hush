/**
 * PDF and stack panes — the two pane types whose content is owned by a
 * component rather than by an editor buffer.
 *
 * Split out of pane-content.js (700-line cap). Both loaders are
 * self-contained: they mount their component into `pane._content` and
 * hang the handle on the pane, and neither participates in
 * `savePaneContent` — a PDF has nothing to write back, and a stack
 * drives its own interval writer (set up here, cleared by the pane's
 * teardown in pane-manager.js).
 */
import { IS_TAURI, tauriInvoke, appState } from "./pane-state.js";

export async function loadPdfPane(pane) {
  const { createPdfViewer } = await import("../pdf/pdf-viewer.js");
  const { findNodeByFileId } = await import("../state/tree-helpers.js");
  const node = findNodeByFileId(appState.fileTree, pane.fileId);
  const zoteroAttKey = node?.zoteroAttKey || null;

  const viewer = createPdfViewer(pane._content, { mode: "pane", zoteroAttKey, fileId: pane.fileId });
  pane.pdfViewer = viewer;

  let bytes;
  try {
    if (IS_TAURI) {
      bytes = await tauriInvoke("load_pdf", { fileId: pane.fileId });
    }
  } catch (e) {
    console.error("Failed to load PDF pane:", e);
  }

  if (bytes) {
    const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    // Contain a bad binary's pdf.js failure to this one pane — an unguarded
    // throw would propagate out of the restore loop and blank the rest.
    await viewer.loadPdf(data).catch((e) => console.error("Failed to render PDF pane:", e));
  }

  try {
    const { getPdfMeta } = await import("../sync/pdf-sync.js");
    const meta = getPdfMeta(pane.fileId);
    if (meta && viewer.setToolbarInfo) {
      viewer.setToolbarInfo(meta.title, meta.firstAuthor);
    }
  } catch {}

  // Restore zoom mode + scroll position. restoreView applies the zoom
  // first (a horizontal layout clamps scrollTop to 0 and vice versa, so
  // the mode has to match before scroll is assigned) and then re-flexes +
  // re-asserts the scroll across several frames — the fit-mode page
  // heights depend on the container's measured size, which often isn't
  // settled the instant a pane mounts, so a single assignment would clamp
  // the position back to the top.
  const targetTop = typeof pane.editorScrollTop === "number" ? pane.editorScrollTop : 0;
  const targetLeft = typeof pane.pdfScrollLeft === "number" ? pane.pdfScrollLeft : 0;
  const zoomLevel = typeof pane.pdfZoomLevel === "number" ? pane.pdfZoomLevel : null;
  if (viewer.restoreView) {
    viewer.restoreView(zoomLevel, targetTop, targetLeft);
  } else {
    if (zoomLevel != null) { try { viewer.setZoom(zoomLevel); } catch (_) {} }
    if (targetTop > 0 || targetLeft > 0) {
      const apply = () => {
        try { viewer.setScrollTop(targetTop); } catch (_) {}
        try { viewer.setScrollLeft(targetLeft); } catch (_) {}
      };
      requestAnimationFrame(apply);
      if (pane.inline) { setTimeout(apply, 100); setTimeout(apply, 500); }
    }
  }

  if (viewer.onScroll) {
    let scrollTimer = null;
    pane._scrollListenerCleanup = viewer.onScroll(() => {
      const nextTop = viewer.getScrollTop();
      const nextLeft = viewer.getScrollLeft();
      // getZoom may not exist on older viewer builds; coalesce to null.
      const nextZoom = typeof viewer.getZoom === "function" ? viewer.getZoom() : null;
      if (nextTop === pane.editorScrollTop
          && nextLeft === pane.pdfScrollLeft
          && nextZoom === pane.pdfZoomLevel) return;
      pane.editorScrollTop = nextTop;
      pane.pdfScrollLeft = nextLeft;
      if (nextZoom != null) pane.pdfZoomLevel = nextZoom;
      if (scrollTimer) clearTimeout(scrollTimer);
      scrollTimer = setTimeout(() => {
        scrollTimer = null;
        import("./pane-persistence.js").then((m) => m.schedulePersist?.()).catch(() => {});
      }, 200);
    });
  }

  if (zoteroAttKey) {
    const userId = appState.settings?.zoteroUserId;
    const apiKey = appState.settings?.zoteroApiKey;
    if (userId && apiKey) {
      try {
        const { getAnnotations } = await import("../zotero-annotations.js");
        const { annotations } = await getAnnotations(zoteroAttKey, userId, apiKey);
        viewer.setAnnotations(annotations);
      } catch (e) {
        console.error("Failed to load PDF pane annotations:", e);
      }
    }
  }
}

export async function loadStackPane(pane) {
  const { StackComponent } = await import("../stack/stack-component.js");
  const { decodeStackContent, encodeStackContent } = await import("../stack/stack-content.js");

  let content = null;
  try {
    if (IS_TAURI) {
      const file = await tauriInvoke("load_file", { id: pane.fileId });
      content = file.content;
    }
  } catch (e) {
    console.error("Failed to load stack pane:", e);
  }

  const data = decodeStackContent(content);
  const stack = new StackComponent(pane._content, data, appState);
  pane.stackInstance = stack;
  // Baseline so the first tick doesn't rewrite the just-loaded content.
  // Must mirror the tick's encode (incl. scrollY + scrollDirection) so the
  // dirty comparison is apples-to-apples.
  {
    const seed = stack.serialize();
    pane._lastStackContent = encodeStackContent(seed.items, seed.scrollX, {
      scrollY: seed.scrollY,
      scrollDirection: seed.scrollDirection,
    });
  }

  const saveInterval = setInterval(async () => {
    if (!pane.stackInstance) return;
    const snapshot = pane.stackInstance.serialize();
    // Pass scrollY + scrollDirection through — without them the pane save
    // would silently reset the stack file's vertical scroll and snap the
    // direction back to "horizontal" every 2 s.
    const encoded = encodeStackContent(snapshot.items, snapshot.scrollX, {
      scrollY: snapshot.scrollY,
      scrollDirection: snapshot.scrollDirection,
    });
    // Idle stack panes re-serialize identically every tick — skip the
    // disk write + sync push unless the content actually changed.
    if (encoded === pane._lastStackContent) return;
    pane._lastStackContent = encoded;
    if (IS_TAURI) {
      try { await tauriInvoke("save_file", { id: pane.fileId, content: encoded }); }
      catch (e) { console.error("Stack pane save failed:", e); }
    }
    appState.syncFileToExternal?.(pane.fileId, encoded);
  }, 2000);

  pane._stackSaveInterval = saveInterval;
}
