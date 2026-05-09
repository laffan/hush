/**
 * Source-of-truth modal — appears once, when the user first links a Hush
 * doc to a Google Doc. Asks which copy is canonical; the answer drives
 * an immediate one-shot push or pull. From that point on, push / pull
 * are explicit user actions on the link bar.
 *
 * Returns a Promise that resolves to:
 *   "hush"   — current Hush doc wins; we should push to GDoc
 *   "gdoc"   — Google Doc wins; we should pull from GDoc
 *   null     — user cancelled (link is *not* established)
 */

export function openSourceOfTruthModal({ hushTitle, gdocTitle }) {
  return new Promise((resolve) => {
    const backdrop = document.createElement("div");
    backdrop.className = "gdoc-sot-backdrop";
    const modal = document.createElement("div");
    modal.className = "gdoc-sot-modal";
    modal.innerHTML = `
      <div class="gdoc-sot-header">Choose source of truth</div>
      <div class="gdoc-sot-body">
        <p>Which version should be the starting point?
        Linking will <strong>replace</strong> the other side with this one.</p>
        <div class="gdoc-sot-options">
          <button class="gdoc-sot-option" data-choice="hush">
            <div class="gdoc-sot-option-title">Use this Hush document</div>
            <div class="gdoc-sot-option-meta">${escHtml(hushTitle || "Untitled")}</div>
            <div class="gdoc-sot-option-detail">Replaces the Google Doc with the Hush content.</div>
          </button>
          <button class="gdoc-sot-option" data-choice="gdoc">
            <div class="gdoc-sot-option-title">Use the Google Doc</div>
            <div class="gdoc-sot-option-meta">${escHtml(gdocTitle || "Untitled")}</div>
            <div class="gdoc-sot-option-detail">Replaces the Hush document with the Google Doc content.</div>
          </button>
        </div>
        <p class="gdoc-sot-versions-note">
          If you pick the wrong one, both Hush and Google Docs keep version
          history — you can recover the previous content from either side.
        </p>
      </div>
      <div class="gdoc-sot-footer">
        <button class="gdoc-sot-cancel">Cancel</button>
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
      if (e.key === "Escape") { e.preventDefault(); close(null); }
    }
    window.addEventListener("keydown", onKey, true);

    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) close(null);
    });
    modal.querySelectorAll(".gdoc-sot-option").forEach((btn) => {
      btn.addEventListener("click", () => close(btn.dataset.choice));
    });
    modal.querySelector(".gdoc-sot-cancel").addEventListener("click", () => close(null));
  });
}

function escHtml(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
