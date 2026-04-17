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
  const rewrite = (content) => rewriteContentImageUrl(content, oldFilename, newFilename);

  for (const fileId of docFileIds) {
    if (fileId === state.currentFileId && state.editor) {
      const cur = state.editor.getContent();
      const updated = rewrite(cur);
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
      const updated = rewrite(file.content);
      if (updated !== file.content) {
        await tauriInvoke("save_file", { id: fileId, content: updated });
      }
    } catch (e) { /* skip files that fail to load */ }
  }
}

/** Rewrite every markdown image ref pointing at `oldName` to point at
 *  `newName`, preserving the `images/` export prefix when present and
 *  quoting the URL when it contains special characters. */
function rewriteContentImageUrl(content, oldName, newName) {
  const re = new RegExp(IMAGE_MD_RE.source, "g");
  return content.replace(re, (match, alt, quotedUrl, bareUrl) => {
    const rawUrl = quotedUrl != null ? quotedUrl : bareUrl;
    const prefix = rawUrl.startsWith("images/") ? "images/" : "";
    const bare = rawUrl.replace(/^images\//, "");
    if (bare !== oldName) return match;
    const nextUrl = prefix + newName;
    const wrapped = urlNeedsQuoteWrap(nextUrl) ? `"${nextUrl}"` : nextUrl;
    return `![${alt}](${wrapped})`;
  });
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

/**
 * Remove every markdown image ref to any of `filenames` from every doc
 * in the tree. Updates the currently-open editor buffer too. If the
 * reference is the only content on its line, the whole line is consumed
 * so removal doesn't leave a blank line behind.
 */
export async function removeImageRefs(state, filenames) {
  if (!filenames?.length) return;
  const set = new Set(filenames);
  const docFileIds = collectDocIds(state.fileTree);
  const strip = (content) => removeContentImageRefs(content, set);
  for (const fileId of docFileIds) {
    if (fileId === state.currentFileId && state.editor) {
      const cur = state.editor.getContent();
      const updated = strip(cur);
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
      const updated = strip(file.content);
      if (updated !== file.content) {
        await tauriInvoke("save_file", { id: fileId, content: updated });
      }
    } catch (e) { /* skip files that fail to load */ }
  }
}

function removeContentImageRefs(content, filenames) {
  // Walk line-by-line so a ref that occupies an entire line can be
  // consumed cleanly without leaving a blank line behind.
  const lines = content.split("\n");
  const soloRe = /^\s*!\[([^\]]*)\]\(\s*(?:"([^"]+)"|([^()\s"]+))(?:\s+"[^"]*")?\s*\)\s*$/;
  const kept = [];
  for (const line of lines) {
    const solo = soloRe.exec(line);
    if (solo) {
      const url = solo[2] != null ? solo[2] : solo[3];
      if (filenames.has(url.replace(/^images\//, ""))) continue; // drop the line entirely
      kept.push(line);
      continue;
    }
    // Inline refs embedded in other text — strip just the ref.
    const inline = new RegExp(IMAGE_MD_RE.source, "g");
    const stripped = line.replace(inline, (match, alt, quotedUrl, bareUrl) => {
      const url = quotedUrl != null ? quotedUrl : bareUrl;
      return filenames.has(url.replace(/^images\//, "")) ? "" : match;
    });
    kept.push(stripped);
  }
  // Collapse runs of blank lines introduced by solo-line removals.
  return kept.join("\n").replace(/\n{3,}/g, "\n\n");
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

/** True when a URL needs to be wrapped in quotes to parse cleanly
 *  (spaces and parens are not allowed in bare markdown URLs). */
export function urlNeedsQuoteWrap(url) {
  return /[\s()]/.test(url);
}

/** Build the canonical markdown for a freshly-dropped image. Wraps the
 *  URL in double quotes when it contains spaces or parens — common for
 *  collision-suffixed names like `brown-cow (2).png`. */
export function buildImageMarkdown(alt, filename) {
  const safeAlt = (alt || "image").replace(/[\[\]]/g, "");
  const url = urlNeedsQuoteWrap(filename) ? `"${filename}"` : filename;
  return `![${safeAlt}](${url})`;
}

/**
 * Unified regex for markdown image syntax supporting either a bare URL
 * (no whitespace, no parens, no quotes) or a quoted URL (`"..."`). The
 * capture groups are: 1 = alt text, 2 = quoted URL (or undefined),
 * 3 = bare URL (or undefined). A trailing `"title"` is optional and
 * ignored.
 */
export const IMAGE_MD_RE = /!\[([^\]]*)\]\(\s*(?:"([^"]+)"|([^()\s"]+))(?:\s+"[^"]*")?\s*\)/g;

/** Pull the URL from an IMAGE_MD_RE match — either the quoted group or
 *  the bare group. */
export function urlFromMatch(match) {
  return match[2] != null ? match[2] : match[3];
}

/**
 * Collect every local image ref from a markdown string. Returns a list of
 * filenames (deduped, in document order).
 */
export function collectImageRefs(state, markdown) {
  const seen = new Set();
  const out = [];
  IMAGE_MD_RE.lastIndex = 0;
  let match;
  while ((match = IMAGE_MD_RE.exec(markdown)) !== null) {
    const filename = filenameFromUrl(urlFromMatch(match));
    if (!filename || seen.has(filename)) continue;
    if (!findImageNode(state, filename)) continue;
    seen.add(filename);
    out.push(filename);
  }
  return out;
}
