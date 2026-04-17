/**
 * Image node operations — stores images under the special Images folder
 * and creates doc image references with the `hush-image:` URI scheme.
 *
 * Each image node: `{ id, name, type: "image", fileId, children: [], flagged }`
 * where `fileId` is `{uuid}.{ext}`. Binary storage lives in the Rust
 * `ImageManager` (files/images/{fileId}).
 */

import { findNode } from "./tree-helpers.js";

const IS_TAURI = typeof window !== "undefined" && window.__TAURI_INTERNALS__;

async function tauriInvoke(cmd, args) {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke(cmd, args);
}

const dataUrlCache = new Map();

export function clearImageCache(fileId) {
  if (fileId) dataUrlCache.delete(fileId);
  else dataUrlCache.clear();
}

/**
 * Read a File (from a drop) as a data URL.
 */
export function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

/** True when the File looks like an image (by MIME or extension). */
export function isImageFile(file) {
  if (!file) return false;
  if (file.type && file.type.startsWith("image/")) return true;
  const ext = (file.name || "").toLowerCase().match(/\.[a-z0-9]+$/)?.[0] || "";
  return [".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp", ".heic", ".heif", ".avif", ".tif", ".tiff"].includes(ext);
}

/** Strip any path + extension from a File's display name. */
function baseName(name) {
  const slash = Math.max(name.lastIndexOf("/"), name.lastIndexOf("\\"));
  const basename = slash >= 0 ? name.slice(slash + 1) : name;
  const dot = basename.lastIndexOf(".");
  return (dot > 0 ? basename.slice(0, dot) : basename) || "image";
}

/**
 * Create a new image node in the Images folder from a dropped File.
 * Returns `{ fileId, name, dataUrl }` or null on failure.
 */
export async function createImageFromFile(state, file) {
  const { AppState } = await import("./state.js");
  if (!file) return null;
  const dataUrl = await fileToDataUrl(file);
  const displayName = baseName(file.name);
  let fileId;
  if (IS_TAURI) {
    try {
      const saved = await tauriInvoke("save_image", { dataUrl });
      fileId = saved.fileId;
    } catch (e) {
      console.error("save_image failed:", e);
      return null;
    }
  } else {
    // Browser fallback: synthesize a file id and keep the data URL in memory.
    const ext = (dataUrl.match(/^data:image\/([a-z0-9+.-]+);/)?.[1] || "png")
      .replace("svg+xml", "svg").replace("jpeg", "jpg");
    fileId = crypto.randomUUID() + "." + ext;
  }
  dataUrlCache.set(fileId, dataUrl);

  // Insert the new node into the Images folder.
  const images = findNode(state.fileTree, AppState.IMAGES_ID);
  if (!images) return { fileId, name: displayName, dataUrl };
  const node = {
    id: crypto.randomUUID(),
    type: "image",
    name: displayName,
    fileId,
    children: [],
    flagged: false,
  };
  (images.children || (images.children = [])).push(node);
  await state.saveFileTree();
  state.emit("files-changed");
  return { fileId, name: displayName, dataUrl };
}

/** Delete an image binary from disk (called by tree-level delete paths). */
export async function deleteImageBinary(fileId) {
  if (!fileId) return;
  dataUrlCache.delete(fileId);
  if (!IS_TAURI) return;
  try { await tauriInvoke("delete_image", { fileId }); }
  catch (e) { console.error("delete_image failed:", e); }
}

/**
 * Resolve an image reference (`hush-image:<fileId>`) to a data URL, caching
 * the result so hover/preview don't re-read the file on every event.
 */
export async function getImageDataUrl(fileId) {
  if (!fileId) return null;
  if (dataUrlCache.has(fileId)) return dataUrlCache.get(fileId);
  if (!IS_TAURI) return null;
  try {
    const url = await tauriInvoke("load_image", { fileId });
    dataUrlCache.set(fileId, url);
    return url;
  } catch (e) {
    console.error("load_image failed:", e);
    return null;
  }
}

/** Parse a markdown image URL into its file id, if it's an internal ref. */
export function fileIdFromUrl(url) {
  if (typeof url !== "string") return null;
  const m = url.match(/^hush-image:([A-Za-z0-9._-]+)$/);
  return m ? m[1] : null;
}

/** Build an internal markdown image reference. */
export function buildImageMarkdown(name, fileId) {
  const safeAlt = (name || "image").replace(/[\[\]]/g, "");
  return `![${safeAlt}](hush-image:${fileId})`;
}

/**
 * Walk a markdown string and collect every internal image reference that
 * resolves to a node in the Images folder. Returns `[{ fileId, name }]`
 * in document order with duplicates removed.
 */
export function collectImageRefs(state, markdown) {
  const { findImageNodeByFileId } = imageLookupHelpers(state);
  const seen = new Set();
  const out = [];
  const re = /!\[[^\]]*\]\(hush-image:([A-Za-z0-9._-]+)\)/g;
  let match;
  while ((match = re.exec(markdown)) !== null) {
    const fileId = match[1];
    if (seen.has(fileId)) continue;
    seen.add(fileId);
    const node = findImageNodeByFileId(fileId);
    if (node) out.push({ fileId, name: node.name });
  }
  return out;
}

function imageLookupHelpers(state) {
  return {
    findImageNodeByFileId(fileId) {
      function walk(nodes) {
        for (const n of nodes || []) {
          if (n.type === "image" && n.fileId === fileId) return n;
          const r = walk(n.children);
          if (r) return r;
        }
        return null;
      }
      return walk(state.fileTree);
    },
  };
}
