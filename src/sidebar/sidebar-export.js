import { findNode } from "../state/tree-helpers.js";

export async function exportCurrentFile(state) {
  if (!state.editor) return;
  let content = state.editor.getContent();
  // For project view, strip separator markers for clean export
  if (state.currentProjectId) {
    content = content.replace(/\n---hush-separator---\n/g, "\n\n");
  }
  const name = state.currentProjectId
    ? (findNode(state.fileTree, state.currentProjectId)?.name || "project-export")
    : (state._deriveName(content) || "hush-export");

  const { collectImageRefs } = await import("../state/state-images.js");
  const images = collectImageRefs(state, content);

  const IS_TAURI = typeof window !== "undefined" && window.__TAURI_INTERNALS__;
  if (IS_TAURI) {
    try {
      if (images.length === 0) {
        const { save } = await import("@tauri-apps/plugin-dialog");
        const filePath = await save({
          defaultPath: `${name}.md`,
          filters: [{ name: "Markdown", extensions: ["md"] }],
        });
        if (filePath) {
          const { writeTextFile } = await import("@tauri-apps/plugin-fs");
          await writeTextFile(filePath, content);
        }
        return;
      }
      // Has images — export as a folder containing text.md + images/
      const { save } = await import("@tauri-apps/plugin-dialog");
      const target = await save({ defaultPath: name });
      if (!target) return;
      const markdown = rewriteImageRefsForExport(content, images);
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("export_with_images", {
        folder: target,
        markdown,
        images,
      });
    } catch (e) {
      console.error("Export failed:", e);
    }
  } else {
    const blob = new Blob([content], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${name}.md`;
    a.click();
    URL.revokeObjectURL(url);
  }
}

/**
 * Rewrite doc markdown so each local image ref gets a relative
 * `images/<filename>` URL. External URLs pass through untouched. Quoted
 * URLs are handled by the shared markdown regex.
 */
function rewriteImageRefsForExport(content, images) {
  const tracked = new Set(images);
  return content.replace(
    /!\[([^\]]*)\]\(\s*(?:"([^"]+)"|([^()\s"]+))(?:\s+"[^"]*")?\s*\)/g,
    (match, alt, quotedUrl, bareUrl) => {
      const raw = quotedUrl != null ? quotedUrl : bareUrl;
      const bare = raw.replace(/^images\//, "");
      if (!tracked.has(bare)) return match;
      const next = `images/${bare}`;
      const wrapped = /[\s()]/.test(next) ? `"${next}"` : next;
      return `![${alt}](${wrapped})`;
    }
  );
}
