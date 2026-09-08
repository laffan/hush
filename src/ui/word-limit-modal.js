/**
 * "Set word count limit" — the small modal behind the command-palette
 * entry of that name.
 *
 * Same shell as the sidebar's prompt modal (`showPromptModal` in
 * files-panel-shared.js) so a cap is set with the same furniture every
 * other name-this prompt uses, with two differences the numeric field
 * earns: the input takes digits only, and a note under it says how many
 * words the document holds right now, which is the number the user is
 * actually choosing against.
 *
 * Re-running the command on a doc that already has a cap opens the
 * modal seeded with it — that is the "change the limit" path; clearing
 * one is its own palette entry.
 */

import { escHtml } from "../sidebar/files-panel-shared.js";
import {
  getWordLimit, setWordLimit, wordLimitTargetFileId, normalizeWordLimit,
} from "../editor/word-limit.js";
import { countWords } from "../editor/plugins/word-count.js";

/** Digits only, and never a leading zero — the field's whole vocabulary. */
function sanitize(raw) {
  return raw.replace(/[^0-9]/g, "").replace(/^0+(?=\d)/, "");
}

export function openWordLimitModal(state) {
  const fileId = wordLimitTargetFileId(state);
  if (!fileId) return;
  const existing = getWordLimit(state, fileId);
  const words = countWords(state.editor?.getContent?.() || "");

  document.querySelectorAll(".tree-delete-modal-backdrop").forEach((el) => el.remove());
  const backdrop = document.createElement("div");
  backdrop.className = "tree-delete-modal-backdrop";
  const modal = document.createElement("div");
  modal.className = "tree-delete-modal";
  modal.innerHTML = `
    <div class="tree-delete-modal-title">Set word count limit</div>
    <label class="tree-prompt-modal-label" for="word-limit-modal-input">Words</label>
    <input id="word-limit-modal-input" class="tree-prompt-modal-input" type="text"
           inputmode="numeric" autocomplete="off" spellcheck="false" placeholder="1000" />
    <div class="word-limit-modal-note">${escHtml(
      `This document has ${words.toLocaleString()} ${words === 1 ? "word" : "words"}.`
    )}</div>
    <div class="tree-delete-modal-btns">
      <button class="tree-delete-cancel">Cancel</button>
      <button class="tree-delete-confirm tree-prompt-modal-confirm">Set</button>
    </div>`;
  backdrop.appendChild(modal);
  document.body.appendChild(backdrop);

  const input = modal.querySelector("input");
  const confirmBtn = modal.querySelector(".tree-prompt-modal-confirm");
  input.value = existing ? String(existing) : "";
  const sync = () => { confirmBtn.disabled = normalizeWordLimit(input.value) === null; };
  sync();

  const cleanup = () => backdrop.remove();
  const submit = () => {
    const limit = normalizeWordLimit(input.value);
    if (limit === null) return;
    cleanup();
    // A cap over a doc that is already longer holds the line where it
    // is: nothing is deleted, and the countdown reads "n over limit"
    // until the user writes their way back under it.
    void setWordLimit(state, fileId, limit);
  };
  const cancel = () => cleanup();

  modal.querySelector(".tree-delete-cancel").addEventListener("click", cancel);
  confirmBtn.addEventListener("click", submit);
  input.addEventListener("input", () => {
    const cleaned = sanitize(input.value);
    if (cleaned !== input.value) input.value = cleaned;
    sync();
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); submit(); }
    else if (e.key === "Escape") { e.preventDefault(); cancel(); }
  });
  backdrop.addEventListener("click", (e) => { if (e.target === backdrop) cancel(); });

  // Focus + select-all so re-running the command overwrites the current
  // cap with a typed digit. Synchronous, inside the gesture that opened
  // the modal, so iOS honours it and raises the keyboard.
  input.focus();
  input.select();
}
