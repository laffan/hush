/**
 * "New Desk" — the single entry point every desk-creation affordance
 * routes through (command palette, the desk switcher's "Add desk" row,
 * and the footer Add popup's "New Desk").
 *
 * Creating a desk forks before anything else can be asked, because the
 * two kinds are named differently:
 *
 *   - **Internal** — lives in Hush's app data. Prompt for a name, and
 *     optionally an icon.
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
 * Both kinds are offered backups — hourly zips of the desk into a folder
 * of the user's choosing (desk-backup-field.js, desk_backup.rs). The
 * internal prompt carries the "Use Backups" checkbox under the name; a
 * local desk has no name to ask for, so the same field follows the
 * folder pick on its own.
 *
 * Outside Tauri there is no folder picker, so the fork is skipped and
 * the internal prompt opens directly.
 */

import { showChoiceModal, typeIcons } from "./files-panel-shared.js";
import { customIconSvg, isCustomIcon } from "../ui/custom-icons.js";
import { openIconPicker } from "../ui/icon-picker-modal.js";
import { setDeskIcon } from "../state/state-desks.js";
import { createBackupField, openDeskBackupPrompt } from "./desk-backup-field.js";
import { setDeskBackupTarget } from "../sync/desk-backups.js";

const IS_TAURI = typeof window !== "undefined" && !!window.__TAURI_INTERNALS__;

/** The internal branch's prompt: the desk's name, and — beside it — its
 *  icon, so a new desk can wear one from the start instead of waiting
 *  for "Change Desk Icon". The icon button opens the shared picker over
 *  this modal (its backdrop is its own, so this one stays put) and shows
 *  whatever was chosen; reset in the picker goes back to the stock
 *  glyph. Under the name, "Use Backups". Calls
 *  `onConfirm(name, icon|null, backupTarget|null)`. */
function showNewDeskPrompt({ onConfirm, onCancel }) {
  document.querySelectorAll(".tree-delete-modal-backdrop").forEach((el) => el.remove());
  const backdrop = document.createElement("div");
  backdrop.className = "tree-delete-modal-backdrop";
  const modal = document.createElement("div");
  modal.className = "tree-delete-modal new-desk-modal";
  modal.innerHTML = `
    <div class="tree-delete-modal-title">New desk</div>
    <label class="tree-prompt-modal-label" for="new-desk-name">Name</label>
    <div class="new-desk-name-row">
      <button type="button" class="new-desk-icon-btn" title="Choose an icon" aria-label="Choose an icon"></button>
      <input id="new-desk-name" class="tree-prompt-modal-input" type="text" autocomplete="off" spellcheck="false"
             placeholder="Untitled desk" />
    </div>
    <div class="new-desk-backup"></div>
    <div class="tree-delete-modal-btns">
      <button class="tree-delete-cancel">Cancel</button>
      <button class="tree-delete-confirm tree-prompt-modal-confirm">Create</button>
    </div>`;
  const backup = createBackupField();
  if (backup) modal.querySelector(".new-desk-backup").appendChild(backup.el);
  else modal.querySelector(".new-desk-backup").remove();
  backdrop.appendChild(modal);
  document.body.appendChild(backdrop);
  const input = modal.querySelector("#new-desk-name");
  const iconBtn = modal.querySelector(".new-desk-icon-btn");
  const confirmBtn = modal.querySelector(".tree-prompt-modal-confirm");
  let icon = null;
  const paintIcon = () => {
    iconBtn.innerHTML = isCustomIcon(icon) ? customIconSvg(icon, "new-desk-icon-glyph") : typeIcons.desk;
    iconBtn.classList.toggle("has-icon", isCustomIcon(icon));
  };
  paintIcon();
  input.value = "Untitled desk";
  const sync = () => { confirmBtn.disabled = input.value.trim().length === 0; };
  sync();
  const cleanup = () => backdrop.remove();
  const submit = () => {
    const value = input.value.trim();
    if (!value) return;
    cleanup();
    onConfirm(value, isCustomIcon(icon) ? icon : null, backup?.value() || null);
  };
  const cancel = () => { cleanup(); onCancel?.(); };
  iconBtn.addEventListener("click", () => {
    openIconPicker({
      title: "Desk icon",
      subject: input.value.trim() || "Untitled desk",
      current: icon,
      defaultIcon: typeIcons.desk,
      onPick: (name) => {
        icon = name;
        paintIcon();
        input.focus();
      },
    });
  });
  modal.querySelector(".tree-delete-cancel").addEventListener("click", cancel);
  confirmBtn.addEventListener("click", submit);
  input.addEventListener("input", sync);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); submit(); }
    else if (e.key === "Escape") { e.preventDefault(); cancel(); }
  });
  backdrop.addEventListener("click", (e) => { if (e.target === backdrop) cancel(); });
  // Focus + select-all inside the opening gesture, so iOS raises the
  // keyboard and the default name is ready to be typed over.
  input.focus();
  input.select();
}

/** Run the create-a-desk flow. Resolves to the new desk's id, or null if
 *  the user backed out at either step. `onCreated` (optional) fires with
 *  the id and its kind ("internal" / "local") before the promise
 *  settles. The new desk becomes the active one; nothing else follows —
 *  the name and icon were chosen in the prompt, so the desk switcher no
 *  longer drops the fresh row into rename. */
export function startNewDeskFlow(state, { onCreated } = {}) {
  return new Promise((resolve) => {
    const internal = () => {
      showNewDeskPrompt({
        onConfirm: async (name, icon, backupTarget) => {
          const id = await state.createDesk(name);
          if (id) {
            if (icon) await setDeskIcon(state, id, icon);
            if (backupTarget) await turnOnBackups(id, backupTarget);
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
        if (id) {
          const name = (state.fileTree || []).find((n) => n.type === "desk" && n.id === id)?.name || "this desk";
          await openDeskBackupPrompt(id, {
            title: `Backups for "${name}"`,
            confirmLabel: "Done",
            cancelLabel: "Skip",
          });
          onCreated?.(id, "local");
        }
        resolve(id || null);
      },
      onCancel: () => resolve(null),
    });
  });
}

/** Point a just-made desk's backups at the folder the prompt chose. The
 *  desk exists either way; a folder Rust refuses is said, not fatal. */
async function turnOnBackups(deskId, target) {
  try {
    await setDeskBackupTarget(deskId, target);
  } catch (e) {
    window.alert(`The desk was made, but backups couldn't use that folder:\n${e?.message || e}\n\nChoose another with "Desk Backup Folder…" in the command palette.`);
  }
}
