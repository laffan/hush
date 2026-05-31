/**
 * Stack export — writes the active stack out as a .hushstack file.
 *
 * Stacks have no other meaningful serialisation (column layout, scroll
 * positions, view state, etc. only round-trip through the JSON envelope),
 * so Export skips the format picker entirely and goes straight to the
 * platform save / share path.
 */

import { findNodeByFileId } from "../state/tree-helpers.js";
import { isIOS } from "../settings/settings-ui.js";

const IS_TAURI = typeof window !== "undefined" && !!window.__TAURI_INTERNALS__;

export async function exportCurrentStack(state) {
  if (!state.currentStackFileId) return;

  const { getStackInstance, getStackFileId } = await import("../stack/stack-bridge.js");
  const inst = getStackInstance();
  if (!inst || getStackFileId() !== state.currentStackFileId) return;

  const { encodeStackContent } = await import("../stack/stack-content.js");
  const snapshot = inst.serialize();
  const content = encodeStackContent(snapshot.items, snapshot.scrollX, {
    scrollY: snapshot.scrollY,
    scrollDirection: snapshot.scrollDirection,
  });

  const name = deriveStackName(state) || "stack-export";
  const fileName = `${name}.hushstack`;

  if (!IS_TAURI) {
    const blob = new Blob([content], { type: "application/x-hushstack" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = fileName;
    a.click();
    URL.revokeObjectURL(url);
    return;
  }

  if (isIOS()) {
    const file = new File([content], fileName, { type: "application/x-hushstack" });
    if (!(navigator.canShare && navigator.canShare({ files: [file] }))) {
      console.error("Web Share API cannot share a .hushstack on this device");
      return;
    }
    try {
      await navigator.share({ files: [file] });
    } catch (e) {
      if (e && (e.name === "AbortError" || /aborted|cancel/i.test(e.message || ""))) return;
      console.error("Stack export share failed:", e);
    }
    return;
  }

  try {
    const { save } = await import("@tauri-apps/plugin-dialog");
    const filePath = await save({
      defaultPath: fileName,
      filters: [{ name: "Hush Stack", extensions: ["hushstack"] }],
    });
    if (!filePath) return;
    const { writeTextFile } = await import("@tauri-apps/plugin-fs");
    await writeTextFile(filePath, content);
  } catch (e) {
    console.error("Stack export failed:", e);
  }
}

function deriveStackName(state) {
  const node = findNodeByFileId(state.fileTree, state.currentStackFileId);
  const raw = node?.name || "stack";
  return raw.replace(/[\/\\:*?"<>|]/g, "-").slice(0, 120) || "stack";
}
