/**
 * Generic custom dropdown widget — extracted from style-modal.js so the
 * modal stays under the 700-line file limit. Used twice in the modal
 * (font and theme dropdowns) and not coupled to the modal's state.
 *
 * Markup contract: a container with `.custom-dropdown` carrying
 * `.custom-dropdown-selected` and `.custom-dropdown-options`, the latter
 * holding `.custom-dropdown-option` rows with `data-value`.
 */
export function bindCustomDropdown(dropdown, onSelect, opts) {
  if (!dropdown) return;
  const selected = dropdown.querySelector(".custom-dropdown-selected");
  const optionsList = dropdown.querySelector(".custom-dropdown-options");
  const onClose = opts && opts.onClose;
  const onHover = opts && opts.onHover;

  function closeDropdown() {
    if (!dropdown.classList.contains("open")) return;
    dropdown.classList.remove("open");
    if (onClose) onClose();
  }

  selected.addEventListener("click", (e) => {
    e.stopPropagation();
    const isOpen = dropdown.classList.contains("open");
    // Closing every other open dropdown also clears their hover preview.
    document.querySelectorAll(".custom-dropdown.open").forEach(d => {
      if (d !== dropdown) d.classList.remove("open");
    });
    if (isOpen) {
      closeDropdown();
    } else {
      dropdown.classList.add("open");
      setTimeout(() => {
        document.addEventListener("mousedown", function handler(e2) {
          if (!dropdown.contains(e2.target)) { closeDropdown(); document.removeEventListener("mousedown", handler); }
        });
      }, 0);
    }
  });

  optionsList.querySelectorAll(".custom-dropdown-option").forEach(opt => {
    opt.addEventListener("click", (e) => {
      e.stopPropagation();
      const value = opt.dataset.value;
      dropdown.dataset.value = value;
      selected.textContent = opt.textContent;
      const optFont = opt.style.fontFamily;
      if (optFont) selected.style.fontFamily = optFont;
      optionsList.querySelectorAll(".custom-dropdown-option").forEach(o => o.classList.remove("selected"));
      opt.classList.add("selected");
      closeDropdown();
      if (onSelect) onSelect(value);
    });
    if (onHover) {
      opt.addEventListener("mouseenter", () => onHover(opt.dataset.value));
    }
  });
  if (onHover) {
    // Cursor leaves the entire option list — clear the hover preview so
    // the pane snaps back to the committed draft state.
    optionsList.addEventListener("mouseleave", () => onHover(null));
  }
}
