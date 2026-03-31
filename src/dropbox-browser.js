/**
 * Dropbox folder browser modal — opens from the settings Sync tab on iPad.
 * Lets the user navigate Dropbox folders and select one to sync.
 */
import { listFolder, getToken } from "./dropbox.js";

/**
 * Open a Dropbox folder browser modal.
 * Returns a Promise that resolves to { path, name } or null if cancelled.
 */
export function openDropboxBrowser() {
  return new Promise((resolve) => {
    const backdrop = document.createElement("div");
    backdrop.className = "dbx-browser-backdrop";

    let currentPath = "";
    let pathStack = []; // for back navigation

    const modal = document.createElement("div");
    modal.className = "dbx-browser-modal";
    modal.innerHTML = `
      <div class="dbx-browser-header">
        <button class="dbx-browser-back" disabled>←</button>
        <span class="dbx-browser-path">/</span>
        <button class="dbx-browser-close">✕</button>
      </div>
      <div class="dbx-browser-list"></div>
      <div class="dbx-browser-footer">
        <button class="dbx-browser-select">Select This Folder</button>
      </div>
    `;
    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);

    const backBtn = modal.querySelector(".dbx-browser-back");
    const pathEl = modal.querySelector(".dbx-browser-path");
    const listEl = modal.querySelector(".dbx-browser-list");
    const selectBtn = modal.querySelector(".dbx-browser-select");
    const closeBtn = modal.querySelector(".dbx-browser-close");

    function close(result) {
      backdrop.remove();
      resolve(result);
    }

    closeBtn.addEventListener("click", () => close(null));
    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) close(null);
    });

    backBtn.addEventListener("click", () => {
      if (pathStack.length > 0) {
        currentPath = pathStack.pop();
        loadFolder(currentPath);
      }
    });

    selectBtn.addEventListener("click", () => {
      const name = currentPath ? currentPath.split("/").filter(Boolean).pop() : "Dropbox";
      close({ path: currentPath || "/", name });
    });

    async function loadFolder(path) {
      pathEl.textContent = path || "/";
      backBtn.disabled = pathStack.length === 0 && path === "";
      listEl.innerHTML = `<div class="dbx-browser-loading">Loading...</div>`;

      try {
        const entries = await listFolder(path);
        const folders = entries.filter(e => e.isFolder).sort((a, b) => a.name.localeCompare(b.name));
        const files = entries.filter(e => !e.isFolder && e.name.endsWith(".md"));

        if (folders.length === 0 && files.length === 0) {
          listEl.innerHTML = `<div class="dbx-browser-empty">Empty folder</div>`;
          return;
        }

        listEl.innerHTML = "";
        for (const folder of folders) {
          const row = document.createElement("div");
          row.className = "dbx-browser-item dbx-browser-folder";
          row.innerHTML = `<span class="dbx-browser-icon">📁</span><span>${escHtml(folder.name)}</span>`;
          row.addEventListener("click", () => {
            pathStack.push(currentPath);
            currentPath = folder.pathDisplay;
            loadFolder(currentPath);
          });
          listEl.appendChild(row);
        }
        for (const file of files) {
          const row = document.createElement("div");
          row.className = "dbx-browser-item dbx-browser-file";
          row.innerHTML = `<span class="dbx-browser-icon">📄</span><span>${escHtml(file.name)}</span>`;
          listEl.appendChild(row);
        }
      } catch (e) {
        listEl.innerHTML = `<div class="dbx-browser-error">Error: ${escHtml(e.message)}</div>`;
      }
    }

    loadFolder("");
  });
}

function escHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
