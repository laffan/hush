/**
 * Image node operations — images live as bare files under the Images
 * folder and are referenced from markdown by their filename (standard
 * markdown syntax, e.g. `![alt | caption](brown-cow.png)`).
 *
 * Each image node: `{ id, name, type: "image", fileId, children: [], flagged }`
 * where `name === fileId === "brown-cow.png"`. The binary lives at
 * `files/images/{fileId}` on disk (Rust `ImageManager`).
 */

import { findNode } from "./tree-helpers.js";

const IS_TAURI = typeof window !== "undefined" && window.__TAURI_INTERNALS__;

async function tauriInvoke(cmd, args) {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke(cmd, args);
}

const dataUrlCache = new Map();

export function clearImageCache(filename) {
  if (filename) dataUrlCache.delete(filename);
  else dataUrlCache.clear();
}

export function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

export function isImageFile(file) {
  if (!file) return false;
  if (file.type && file.type.startsWith("image/")) return true;
  const ext = (file.name || "").toLowerCase().match(/\.[a-z0-9]+$/)?.[0] || "";
  return [".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp", ".heic", ".heif", ".avif", ".tif", ".tiff"].includes(ext);
}

/** Drop the leading path and keep the bare filename (with extension). */
function baseName(name) {
  if (!name) return "image";
  const slash = Math.max(name.lastIndexOf("/"), name.lastIndexOf("\\"));
  const basename = slash >= 0 ? name.slice(slash + 1) : name;
  return basename || "image";
}

/** Derive the alt text shown in the editor from a filename. */
function altFromFilename(filename) {
  const base = filename.replace(/\.[^.]+$/, "");
  return base || "image";
}

/**
 * Save a dropped File to the Images folder, creating a tree node.
 * Returns `{ filename, alt, dataUrl }` or null on failure.
 */
export async function createImageFromFile(state, file) {
  const { AppState } = await import("./state.js");
  if (!file) return null;
  const dataUrl = await fileToDataUrl(file);
  const requestedName = baseName(file.name);
  let finalName;
  if (IS_TAURI) {
    try {
      const saved = await tauriInvoke("save_image", { filename: requestedName, dataUrl });
      finalName = saved.filename;
    } catch (e) {
      console.error("save_image failed:", e);
      return null;
    }
  } else {
    // Browser fallback — no collision check.
    finalName = requestedName;
  }
  dataUrlCache.set(finalName, dataUrl);

  const images = findNode(state.fileTree, AppState.IMAGES_ID);
  if (images) {
    // Avoid duplicate tree nodes if the backend disambiguated a second
    // copy of the same filename.
    const already = (images.children || []).some((c) => c.type === "image" && c.fileId === finalName);
    if (!already) {
      const node = {
        id: crypto.randomUUID(),
        type: "image",
        name: finalName,
        fileId: finalName,
        children: [],
        flagged: false,
      };
      (images.children || (images.children = [])).push(node);
      await state.saveFileTree();
      state.emit("files-changed");
    }
  }
  return { filename: finalName, alt: altFromFilename(finalName), dataUrl };
}

/** Delete an image binary from disk. */
export async function deleteImageBinary(filename) {
  if (!filename) return;
  dataUrlCache.delete(filename);
  if (!IS_TAURI) return;
  try { await tauriInvoke("delete_image", { filename }); }
  catch (e) { console.error("delete_image failed:", e); }
}

/**
 * Rename an image on disk and rewrite all doc references in one pass.
 * Returns the final filename (possibly suffixed to avoid collision).
 */
export async function renameImageFile(state, oldFilename, newFilename) {
  if (!oldFilename || !newFilename || oldFilename === newFilename) return oldFilename;
  let finalName = newFilename;
  if (IS_TAURI) {
    try {
      finalName = await tauriInvoke("rename_image", {
        oldFilename,
        newFilename,
      });
    } catch (e) {
      console.error("rename_image failed:", e);
      return oldFilename;
    }
  }
  dataUrlCache.delete(oldFilename);
  dataUrlCache.delete(finalName);
  await rewriteImageRefs(state, oldFilename, finalName);
  return finalName;
}

/**
 * Walk every document in the tree and rewrite markdown image refs that
 * point at `oldFilename` to `newFilename`. Updates the in-memory editor
 * if the current document is affected.
 */
async function rewriteImageRefs(state, oldFilename, newFilename) {
  const docFileIds = collectDocIds(state.fileTree);
  const oldRe = new RegExp(`(!\\[[^\\]]*\\]\\(\\s*)${escapeRegex(oldFilename)}(\\s*(?:"[^"]*")?\\s*\\))`, "g");

  for (const fileId of docFileIds) {
    if (fileId === state.currentFileId && state.editor) {
      const cur = state.editor.getContent();
      const updated = cur.replace(oldRe, `$1${newFilename}$2`);
      if (updated !== cur) {
        state.editor.setContent(updated);
        state.markDirty();
        await state.saveCurrentFile();
      }
      continue;
    }
    if (!IS_TAURI) continue;
    try {
      const file = await tauriInvoke("load_file", { id: fileId });
      const updated = file.content.replace(oldRe, `$1${newFilename}$2`);
      if (updated !== file.content) {
        await tauriInvoke("save_file", { id: fileId, content: updated });
      }
    } catch (e) { /* skip files that fail to load */ }
  }
}

function collectDocIds(nodes) {
  const out = [];
  function walk(n) {
    if (!n) return;
    if (n.type === "document" && n.fileId) out.push(n.fileId);
    if (n.children) n.children.forEach(walk);
  }
  nodes.forEach(walk);
  return out;
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Build a regex that matches every markdown image ref to any of the
 *  given filenames (both bare and `images/{filename}` forms). If the
 *  match is the only non-whitespace content on its line, the whole line
 *  is consumed (including the trailing newline) so removal doesn't leave
 *  a blank line behind. */
function removalRegex(filenames) {
  const alts = filenames.map(escapeRegex).join("|");
  // Group 1 captures the image syntax; we let the engine decide between
  // line-consuming and inline match via two alternatives.
  const pattern = `(?:^[ \\t]*!\\[[^\\]]*\\]\\(\\s*(?:images/)?(?:${alts})(?:\\s*"[^"]*")?\\s*\\)[ \\t]*\\n?)|!\\[[^\\]]*\\]\\(\\s*(?:images/)?(?:${alts})(?:\\s*"[^"]*")?\\s*\\)`;
  return new RegExp(pattern, "gm");
}

/**
 * Remove every markdown image ref to any of `filenames` from every doc
 * in the tree. Updates the currently-open editor buffer too.
 */
export async function removeImageRefs(state, filenames) {
  if (!filenames?.length) return;
  const re = removalRegex(filenames);
  const docFileIds = collectDocIds(state.fileTree);
  for (const fileId of docFileIds) {
    if (fileId === state.currentFileId && state.editor) {
      const cur = state.editor.getContent();
      const updated = cur.replace(re, "");
      if (updated !== cur) {
        state.editor.setContent(updated);
        state.markDirty();
        await state.saveCurrentFile();
      }
      continue;
    }
    if (!IS_TAURI) continue;
    try {
      const file = await tauriInvoke("load_file", { id: fileId });
      const updated = file.content.replace(re, "");
      if (updated !== file.content) {
        await tauriInvoke("save_file", { id: fileId, content: updated });
      }
    } catch (e) { /* skip files that fail to load */ }
  }
}

/**
 * Resolve a filename to a data URL, caching the result.
 */
export async function getImageDataUrl(filename) {
  if (!filename) return null;
  if (dataUrlCache.has(filename)) return dataUrlCache.get(filename);
  if (!IS_TAURI) return null;
  try {
    const url = await tauriInvoke("load_image", { filename });
    dataUrlCache.set(filename, url);
    return url;
  } catch (e) {
    console.error("load_image failed:", e);
    return null;
  }
}

/** True if the markdown URL resolves to one of our tracked images. */
export function isLocalImageRef(state, url) {
  if (!url) return false;
  // Reject URLs with schemes, absolute paths, or directory traversal — we
  // only decorate bare filenames stored in the Images folder.
  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return false;
  if (url.startsWith("/") || url.includes("..") || url.includes("\\")) return false;
  // Accept refs of either `brown-cow.png` or `images/brown-cow.png` form —
  // the latter matches what exports rewrite to.
  const filename = url.replace(/^images\//, "");
  return !!findImageNode(state, filename);
}

/** Find an image tree node by filename (trashed images are excluded). */
export function findImageNode(state, filename) {
  function walk(nodes) {
    for (const n of nodes || []) {
      if (n.id === "__trash__") continue;
      if (n.type === "image" && n.fileId === filename) return n;
      const r = walk(n.children);
      if (r) return r;
    }
    return null;
  }
  return walk(state.fileTree);
}

/** Extract filename from a markdown URL (strips `images/` prefix). */
export function filenameFromUrl(url) {
  if (!url) return null;
  return url.replace(/^images\//, "").trim();
}

/**
 * Parse `"alt text | caption text"` into `{alt, caption}`. Missing caption
 * returns `{alt, caption: null}`. Whitespace around each side is trimmed.
 */
export function parseAltAndCaption(rawAlt) {
  if (!rawAlt) return { alt: "", caption: null };
  const pipe = rawAlt.indexOf("|");
  if (pipe < 0) return { alt: rawAlt.trim(), caption: null };
  return {
    alt: rawAlt.slice(0, pipe).trim(),
    caption: rawAlt.slice(pipe + 1).trim() || null,
  };
}

/** Build the canonical markdown for a freshly-dropped image. */
export function buildImageMarkdown(alt, filename) {
  const safe = (alt || "image").replace(/[\[\]]/g, "");
  return `![${safe}](${filename})`;
}

/**
 * Collect every local image ref from a markdown string. Returns a list of
 * filenames (deduped, in document order).
 */
export function collectImageRefs(state, markdown) {
  const seen = new Set();
  const out = [];
  const re = /!\[[^\]]*\]\(\s*([^)\s"]+)(?:\s+"[^"]*")?\s*\)/g;
  let match;
  while ((match = re.exec(markdown)) !== null) {
    const filename = filenameFromUrl(match[1]);
    if (!filename || seen.has(filename)) continue;
    if (!findImageNode(state, filename)) continue;
    seen.add(filename);
    out.push(filename);
  }
  return out;
}
