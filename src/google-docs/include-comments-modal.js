/**
 * Include-comments modal — shown during an Import / Pull when the Google
 * Doc carries open comments. Asks whether to weave them into the Hush
 * document as comment anchors or leave them behind (they stay untouched
 * in Google either way — skipping just keeps the markdown clean).
 *
 * Reuses the source-of-truth modal's styling so the two link-flow prompts
 * read as one family. Returns a Promise resolving to:
 *   true   — include the comments
 *   false  — skip them
 */

export function openIncludeCommentsModal(count) {
  return new Promise((resolve) => {
    const n = Math.max(1, count | 0);
    const noun = n === 1 ? "comment" : "comments";
    const backdrop = document.createElement("div");
    backdrop.className = "gdoc-sot-backdrop";
    const modal = document.createElement("div");
    modal.className = "gdoc-sot-modal";
    modal.innerHTML = `
      <div class="gdoc-sot-header">Include comments?</div>
      <div class="gdoc-sot-body">
        <p>This Google Doc has <strong>${n} open ${noun}</strong>.</p>
        <div class="gdoc-sot-options">
          <button class="gdoc-sot-option" data-choice="include">
            <div class="gdoc-sot-option-title">Include ${noun}</div>
            <div class="gdoc-sot-option-detail">Imports the ${noun} anchored to the text they were attached to.</div>
          </button>
          <button class="gdoc-sot-option" data-choice="skip">
            <div class="gdoc-sot-option-title">Skip ${noun}</div>
            <div class="gdoc-sot-option-detail">Imports just the text. The ${noun} stay untouched in Google.</div>
          </button>
        </div>
      </div>
    `;
    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);

    function close(result) {
      window.removeEventListener("keydown", onKey, true);
      backdrop.remove();
      resolve(result);
    }
    function onKey(e) {
      if (e.key === "Escape") { e.preventDefault(); close(false); }
    }
    window.addEventListener("keydown", onKey, true);

    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) close(false);
    });
    modal.querySelectorAll(".gdoc-sot-option").forEach((btn) => {
      btn.addEventListener("click", () => close(btn.dataset.choice === "include"));
    });
  });
}
