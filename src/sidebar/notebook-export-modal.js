/**
 * Notebook export modal.
 *
 * Shown when the user presses Export while a notebook is open (doc
 * export stays on its existing fast path in sidebar.js). Collects
 * scope, optional margin, format, scale, and a background toggle,
 * then hands the choices to `exportNotebook()`.
 */

import { isIOS } from "../settings/settings-ui.js";

const IS_TAURI = typeof window !== "undefined" && window.__TAURI_INTERNALS__;

const DEFAULT_MARGIN = 40;

/** Open the modal. Returns a cleanup function. */
export async function openNotebookExportModal(state) {
  const { getCanvasInstance } = await import("../notebook/notebook-bridge.js");
  const canvasInstance = getCanvasInstance();
  if (!canvasInstance) return () => {};

  // Remove any previous instance
  document.querySelectorAll(".notebook-export-modal").forEach((el) => el.remove());
  document.querySelectorAll(".notebook-export-backdrop").forEach((el) => el.remove());

  const backdrop = document.createElement("div");
  backdrop.className = "notebook-export-backdrop";

  const modal = document.createElement("div");
  modal.className = "notebook-export-modal";

  // State captured in closure
  const choices = {
    scope: "visible",
    margin: DEFAULT_MARGIN,
    format: "png",
    scale: 1,
    includeBackground: true,
  };

  modal.innerHTML = `
    <div class="nxm-title">Export notebook</div>

    <div class="nxm-section" data-hide-when="format=hushnote">
      <div class="nxm-label">Scope</div>
      <div class="nxm-seg" data-group="scope">
        <button data-value="visible" class="active">Visible window</button>
        <button data-value="all">All content</button>
      </div>
      <div class="nxm-margin" data-visible-when="scope=all">
        <label>Margin
          <input type="number" min="0" max="500" step="10" value="${DEFAULT_MARGIN}" class="nxm-margin-input" />
          <span class="nxm-units">px</span>
        </label>
      </div>
    </div>

    <div class="nxm-section">
      <div class="nxm-label">Format</div>
      <div class="nxm-seg" data-group="format">
        <button data-value="hushnote">.hushnote</button>
        <button data-value="png" class="active">PNG</button>
        <button data-value="jpg">JPG</button>
        <button data-value="pdf">PDF</button>
      </div>
    </div>

    <div class="nxm-section" data-hide-when="format=hushnote">
      <div class="nxm-label">Scale</div>
      <div class="nxm-seg" data-group="scale">
        <button data-value="1" class="active">1×</button>
        <button data-value="2">2×</button>
        <button data-value="3">3×</button>
      </div>
    </div>

    <div class="nxm-section" data-hide-when="format=hushnote">
      <label class="nxm-checkbox-label">
        <input type="checkbox" class="nxm-bg-toggle" checked />
        Include background
      </label>
    </div>

    <div class="nxm-actions">
      <button class="nxm-cancel">Cancel</button>
      <button class="nxm-confirm">Export</button>
    </div>
  `;

  document.body.appendChild(backdrop);
  document.body.appendChild(modal);

  const cleanup = () => {
    backdrop.remove();
    modal.remove();
    document.removeEventListener("keydown", onKey);
  };
  const onKey = (e) => {
    if (e.key === "Escape") cleanup();
    if (e.key === "Enter" && !e.isComposing) {
      const active = document.activeElement;
      const inInput = active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA");
      if (!inInput) { e.preventDefault(); void runExport(); }
    }
  };
  document.addEventListener("keydown", onKey);
  backdrop.addEventListener("click", cleanup);

  // Segment button wiring
  modal.querySelectorAll(".nxm-seg").forEach((group) => {
    group.addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-value]");
      if (!btn) return;
      const key = group.getAttribute("data-group");
      const value = btn.dataset.value;
      choices[key] = key === "scale" ? parseInt(value, 10) : value;
      group.querySelectorAll("button").forEach((b) => b.classList.toggle("active", b === btn));
      applyConditionalVisibility();
    });
  });

  // Margin input
  const marginInput = modal.querySelector(".nxm-margin-input");
  marginInput.addEventListener("input", () => {
    const v = parseInt(marginInput.value, 10);
    choices.margin = Number.isFinite(v) && v >= 0 ? v : 0;
  });

  // Background toggle
  const bgToggle = modal.querySelector(".nxm-bg-toggle");
  bgToggle.addEventListener("change", () => { choices.includeBackground = bgToggle.checked; });

  // Buttons
  modal.querySelector(".nxm-cancel").addEventListener("click", cleanup);
  modal.querySelector(".nxm-confirm").addEventListener("click", () => { void runExport(); });

  applyConditionalVisibility();

  function applyConditionalVisibility() {
    for (const el of modal.querySelectorAll("[data-visible-when]")) {
      const [key, val] = el.dataset.visibleWhen.split("=");
      el.style.display = choices[key] === val ? "" : "none";
    }
    for (const el of modal.querySelectorAll("[data-hide-when]")) {
      const [key, val] = el.dataset.hideWhen.split("=");
      el.style.display = choices[key] === val ? "none" : "";
    }
  }

  async function runExport() {
    const flashFail = () => {
      const confirmBtn = modal.querySelector(".nxm-confirm");
      if (!confirmBtn) return;
      const prev = confirmBtn.textContent;
      confirmBtn.textContent = "Export failed";
      setTimeout(() => { confirmBtn.textContent = prev; }, 1800);
    };

    try {
      const name = deriveNotebookName(state) || "notebook-export";
      const { exportNotebook, extensionForFormat } = await import("../notebook/notebook-export.ts");
      const bytes = await exportNotebook(canvasInstance, choices);
      const ext = extensionForFormat(choices.format);
      const fileName = `${name}.${ext}`;

      if (IS_TAURI) {
        if (isIOS()) {
          // iOS path: hand the file straight to the webview's
          // navigator.share (Web Share API). The iOS share sheet lets
          // the user pick Files / AirDrop / Mail / etc. — no Rust
          // bridge, no Swift plugin, no security-scoped URLs.
          const file = new File([bytes], fileName, { type: mimeForFormat(choices.format) });
          if (!(navigator.canShare && navigator.canShare({ files: [file] }))) {
            throw new Error("Web Share API cannot share this file on this device");
          }
          try {
            await navigator.share({ files: [file] });
          } catch (e) {
            // User-dismissed share sheets throw AbortError — not a failure.
            if (e && (e.name === "AbortError" || /aborted|cancel/i.test(e.message || ""))) {
              cleanup();
              return;
            }
            throw e;
          }
        } else {
          const { save } = await import("@tauri-apps/plugin-dialog");
          const filePath = await save({ defaultPath: fileName, filters: filterForFormat(choices.format) });
          if (!filePath) return; // user cancelled, keep modal open
          const { invoke } = await import("@tauri-apps/api/core");
          await invoke("write_binary_file", { path: filePath, bytes: Array.from(bytes) });
        }
      } else {
        const blob = new Blob([bytes], { type: mimeForFormat(choices.format) });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = fileName;
        a.click();
        URL.revokeObjectURL(url);
      }

      cleanup();
    } catch (err) {
      console.error("Notebook export failed:", err);
      flashFail();
    }
  }

  return cleanup;
}

function deriveNotebookName(state) {
  const id = state.currentNotebookFileId;
  if (!id) return null;
  // The tree node carries the user-facing name; files[].name is a
  // mirror but the tree wins when both exist.
  const node = findTreeNodeByFileId(state.fileTree, id);
  if (node?.name) return sanitizeFilename(node.name);
  const f = (state.files || []).find((x) => x.id === id);
  return f?.name ? sanitizeFilename(f.name) : null;
}

function findTreeNodeByFileId(nodes, fileId) {
  if (!Array.isArray(nodes)) return null;
  for (const n of nodes) {
    if (n.fileId === fileId) return n;
    if (n.children) {
      const hit = findTreeNodeByFileId(n.children, fileId);
      if (hit) return hit;
    }
  }
  return null;
}

function sanitizeFilename(name) {
  return name.replace(/[\/\\:*?"<>|]/g, "-").slice(0, 120) || "notebook";
}

function filterForFormat(format) {
  switch (format) {
    case "png": return [{ name: "PNG", extensions: ["png"] }];
    case "jpg": return [{ name: "JPEG", extensions: ["jpg", "jpeg"] }];
    case "pdf": return [{ name: "PDF", extensions: ["pdf"] }];
    case "hushnote": return [{ name: "Hush Notebook", extensions: ["hushnote"] }];
  }
  return [];
}

function mimeForFormat(format) {
  switch (format) {
    case "png": return "image/png";
    case "jpg": return "image/jpeg";
    case "pdf": return "application/pdf";
    case "hushnote": return "application/json";
  }
  return "application/octet-stream";
}

