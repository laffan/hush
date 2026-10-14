/**
 * Change icon — the one picker behind every custom-icon entry point:
 * the palette's "Change Desk Icon" and the "Change icon" row-menu entry
 * on folders and projects.
 *
 * The picker only chooses; the caller owns where the choice is stored
 * (`node.icon` on a folder or project, `desksMeta[deskId].icon` on a
 * desk). `onPick(name)` receives an icon name from the tiny-icons set,
 * or `null` for "Reset to default", and the modal closes either way.
 *
 * Same shell as the sidebar's prompt modals (`.tree-delete-modal`), with
 * a search field over a grid of the whole set drawn at 30 px — the size
 * the desk switcher shows a desk's icon at. Typing filters the grid by
 * name; Enter takes the first icon still showing.
 */

import { escHtml } from "../sidebar/files-panel-shared.js";
import { CUSTOM_ICON_NAMES, customIconSvg, customIconLabel, isCustomIcon } from "./custom-icons.js";

/**
 * @param {{ title: string, subject: string, current: string|null,
 *           defaultIcon: string, onPick: (name: string|null) => void }} opts
 *   `subject` names what is being changed (the desk / folder / project);
 *   `defaultIcon` is the stock glyph's SVG markup, shown on the reset
 *   button so it says what resetting gives back.
 */
export function openIconPicker({ title, subject, current, defaultIcon, onPick }) {
  document.querySelectorAll(".icon-picker-backdrop").forEach((el) => el.remove());
  const active = isCustomIcon(current) ? current : null;

  const backdrop = document.createElement("div");
  backdrop.className = "tree-delete-modal-backdrop icon-picker-backdrop";
  const modal = document.createElement("div");
  modal.className = "tree-delete-modal icon-picker-modal";
  const cells = CUSTOM_ICON_NAMES.map((name) => {
    const label = escHtml(customIconLabel(name));
    return `<button type="button" class="icon-picker-cell${name === active ? " active" : ""}"
      data-icon="${name}" title="${label}" aria-label="${label}">${customIconSvg(name, "icon-picker-glyph")}</button>`;
  }).join("");
  modal.innerHTML = `
    <div class="tree-delete-modal-title">${escHtml(title)}</div>
    <div class="icon-picker-subject">
      <span class="icon-picker-subject-icon">${active ? customIconSvg(active, "icon-picker-subject-glyph") : defaultIcon}</span>
      <span class="icon-picker-subject-name">${escHtml(subject)}</span>
    </div>
    <input class="tree-prompt-modal-input icon-picker-search" type="text" placeholder="Search icons"
           autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" />
    <div class="icon-picker-grid" role="listbox" aria-label="Icons">${cells}</div>
    <div class="icon-picker-empty" hidden>No icon matches.</div>
    <div class="tree-delete-modal-btns icon-picker-btns">
      <button type="button" class="icon-picker-reset"${active ? "" : " disabled"}>
        <span class="icon-picker-reset-icon">${defaultIcon}</span>Reset to default
      </button>
      <button type="button" class="tree-delete-cancel">Cancel</button>
    </div>`;
  backdrop.appendChild(modal);
  document.body.appendChild(backdrop);

  const search = modal.querySelector(".icon-picker-search");
  const grid = modal.querySelector(".icon-picker-grid");
  const empty = modal.querySelector(".icon-picker-empty");

  const close = () => {
    backdrop.remove();
    document.removeEventListener("keydown", onKey, true);
  };
  const choose = (name) => {
    close();
    onPick(name);
  };
  const onKey = (e) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    close();
  };
  document.addEventListener("keydown", onKey, true);

  backdrop.addEventListener("mousedown", (e) => { if (e.target === backdrop) close(); });
  modal.querySelector(".tree-delete-cancel").addEventListener("click", close);
  modal.querySelector(".icon-picker-reset").addEventListener("click", () => choose(null));
  grid.addEventListener("click", (e) => {
    const cell = e.target.closest(".icon-picker-cell");
    if (cell) choose(cell.dataset.icon);
  });

  // Matches on the label ("soda can"), so a space or a hyphen both work.
  search.addEventListener("input", () => {
    const q = search.value.trim().toLowerCase().replace(/-/g, " ");
    let shown = 0;
    for (const cell of grid.children) {
      const hit = !q || cell.dataset.icon.replace(/-/g, " ").includes(q);
      cell.hidden = !hit;
      if (hit) shown += 1;
    }
    empty.hidden = shown > 0;
  });
  search.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    const first = [...grid.children].find((c) => !c.hidden);
    if (first) choose(first.dataset.icon);
  });

  search.focus();
  grid.querySelector(".active")?.scrollIntoView({ block: "nearest" });
}
