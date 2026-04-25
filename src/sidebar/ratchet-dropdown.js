export function showRatchetDropdownCentered(state, onStart) {
  document.querySelectorAll(".ratchet-dropdown").forEach((el) => el.remove());

  const dropdown = document.createElement("div");
  dropdown.className = "ratchet-dropdown ratchet-dropdown-centered";

  // Options section (checkboxes)
  const optionsSection = document.createElement("div");
  optionsSection.className = "ratchet-options-section";

  const encourageLabel = document.createElement("label");
  encourageLabel.className = "ratchet-checkbox-label";
  const encourageCheckbox = document.createElement("input");
  encourageCheckbox.type = "checkbox";
  encourageCheckbox.checked = !!state.settings.ratchetEncourageTyping;
  encourageCheckbox.addEventListener("change", () => {
    state.updateSettings({ ratchetEncourageTyping: encourageCheckbox.checked });
  });
  encourageLabel.appendChild(encourageCheckbox);
  encourageLabel.appendChild(document.createTextNode(" Encourage typing"));
  optionsSection.appendChild(encourageLabel);
  dropdown.appendChild(optionsSection);

  const grid = document.createElement("div");
  grid.className = "ratchet-duration-grid";
  const durations = [5, 10, 15, 20, 25, 30, 45, 60];
  durations.forEach((min) => {
    const opt = document.createElement("div");
    opt.className = "ratchet-option";
    opt.textContent = min === 60 ? "1 hr" : `${min} min`;
    opt.addEventListener("click", () => {
      state.startRatchet(min);
      dropdown.remove();
      onStart();
    });
    grid.appendChild(opt);
  });
  dropdown.appendChild(grid);
  document.body.appendChild(dropdown);

  setTimeout(() => {
    document.addEventListener("mousedown", function handler(e) {
      if (!dropdown.contains(e.target)) {
        dropdown.remove();
        document.removeEventListener("mousedown", handler);
      }
    });
  }, 0);
}
