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
 * **The document's own count is the floor.** A cap under it would be a
 * cap the document is already past — nothing to write towards, every
 * key refused, and no way back other than deleting words that were
 * fine when they were written. The field refuses those numbers rather
 * than accepting one and leaving the user stuck in it, and the note
 * says which number it is refusing them for.
 *
 * Re-running the command on a doc that already has a cap opens the
 * modal seeded with it — that is the "change the limit" path; clearing
 * one is its own palette entry.
 */

import { escHtml } from "../sidebar/files-panel-shared.js";
import {
  getWordLimit, setWordLimit, wordLimitTargetFileId, normalizeWordLimit,
} from "../editor/word-limit-store.js";
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
  const note = modal.querySelector(".word-limit-modal-note");
  const confirmBtn = modal.querySelector(".tree-prompt-modal-confirm");
  input.value = existing ? String(existing) : "";
  const wordsNote = `This document has ${words.toLocaleString()} ${words === 1 ? "word" : "words"}.`;
  const sync = () => {
    const limit = normalizeWordLimit(input.value);
    const tooLow = limit !== null && limit < words;
    confirmBtn.disabled = limit === null || tooLow;
    note.textContent = tooLow
      ? `Already ${words.toLocaleString()} ${words === 1 ? "word" : "words"} — a limit can't be lower.`
      : wordsNote;
    note.classList.toggle("invalid", tooLow);
  };
  sync();

  const cleanup = () => backdrop.remove();
  const submit = () => {
    const limit = normalizeWordLimit(input.value);
    if (limit === null || limit < words) return;
    cleanup();
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
