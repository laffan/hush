/**
 * "New Desk" — the single entry point every desk-creation affordance
 * routes through (command palette, the desk switcher's "Add desk" row,
 * and the footer Add popup's "New Desk").
 *
 * Creating a desk forks before anything else can be asked, because the
 * two kinds are named differently:
 *
 *   - **Internal** — lives in Hush's app data. Prompt for a name.
 *   - **Local** — the folder the user picks (an iCloud Drive or Dropbox
 *     folder, a USB stick, anywhere) *becomes* the desk: Hush writes its
 *     sidecar into it and absorbs whatever files are already there. A
 *     local desk takes the *folder's* name, so there's nothing to prompt
 *     for — the picker is the whole flow, and the desk can't be renamed
 *     afterwards (rename the folder instead).
 *
 * The local branch is named for what people actually come here to do —
 * **Use Local Folder as Desk…** — because the two jobs it does are one
 * gesture: make a plain folder into a desk, *and* pick up the folder
 * another device already keeps a desk in. Labelling it "Local folder…"
 * left the second job with no visible door, and people went looking for
 * one (see README-SYNC § desk identity).
 *
 * Outside Tauri there is no folder picker, so the fork is skipped and
 * the internal prompt opens directly.
 */

import { showChoiceModal, showPromptModal } from "./files-panel-shared.js";

const IS_TAURI = typeof window !== "undefined" && !!window.__TAURI_INTERNALS__;

/** Run the create-a-desk flow. Resolves to the new desk's id, or null if
 *  the user backed out at either step. `onCreated` (optional) fires with
 *  the id before the promise settles — the desk switcher uses it to drop
 *  the fresh row into inline-rename mode, which only applies to the
 *  internal branch. */
export function startNewDeskFlow(state, { onCreated } = {}) {
  return new Promise((resolve) => {
    const internal = () => {
      showPromptModal({
        title: "New desk",
        label: "Name",
        placeholder: "Untitled desk",
        initialValue: "Untitled desk",
        confirmLabel: "Create",
        onConfirm: async (name) => {
          const id = await state.createDesk(name);
          if (id) {
            await state.setActiveDesk(id);
            onCreated?.(id, "internal");
          }
          resolve(id || null);
        },
        onCancel: () => resolve(null),
      });
    };

    if (!IS_TAURI) { internal(); return; }

    showChoiceModal({
      title: "New desk",
      message: "Where should this desk live?",
      options: [
        {
          id: "internal",
          label: "Internal",
          detail: "Stored inside Hush. The usual choice — you name it, and can rename it later.",
        },
        {
          id: "local",
          label: "Use Local Folder as Desk…",
          detail: "The folder you pick becomes the desk — it takes that folder's name, and any files "
            + "already inside come with it. Pick a folder your other device already keeps a desk in "
            + "(iCloud Drive, Dropbox, Syncthing) and you join that desk, files and history intact.",
        },
      ],
      onPick: async (choice) => {
        if (choice === "internal") { internal(); return; }
        const { createLocalDesk } = await import("../sync/desk-roots.js");
        const id = await createLocalDesk(state);
        if (id) onCreated?.(id, "local");
        resolve(id || null);
      },
      onCancel: () => resolve(null),
    });
  });
}
