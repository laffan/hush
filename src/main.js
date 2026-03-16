import { createEditor } from "./editor.js";
import { createSidebar } from "./sidebar.js";
import { AppState } from "./state.js";
import { setupTauriIntegration } from "./tauri-bridge.js";

async function init() {
  const state = new AppState();
  await state.init();

  const editor = createEditor(document.getElementById("editor-container"), state);
  state.setEditor(editor);

  createSidebar(document.getElementById("sidebar"), state);

  await setupTauriIntegration(state);

  // Apply saved theme
  document.documentElement.setAttribute("data-theme", state.settings.theme || "dark");
}

init().catch(console.error);
