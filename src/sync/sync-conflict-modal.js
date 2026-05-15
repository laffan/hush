/**
 * Sync conflict modal — fires when a rev-gated upload returns 409
 * because the remote has moved since we last read it. Three choices:
 *   "local"   — push the local content over the remote (next upload
 *               uses the just-pulled rev as its update precondition)
 *   "remote"  — accept the remote content as the new local state
 *   "versions" — open the Versions panel for this file and dismiss
 *
 * Local content is snapshotted on either branch so the user can walk
 * back through Versions if they pick the wrong side.
 *
 * Concurrent conflicts queue: openSyncConflictModal returns a promise
 * that resolves to the user's choice (or null if dismissed). The
 * caller serializes prompts per file via a module-level lock so two
 * arrival events for the same file don't stack overlapping modals.
 */

const _pendingByFile = new Map(); // internalId → in-flight Promise

export function openSyncConflictModal({ fileName, localPreview, remotePreview, internalId }) {
  if (internalId && _pendingByFile.has(internalId)) {
    return _pendingByFile.get(internalId);
  }
  const p = _openModal({ fileName, localPreview, remotePreview });
  if (internalId) {
    _pendingByFile.set(internalId, p);
    p.finally(() => _pendingByFile.delete(internalId));
  }
  return p;
}

function _openModal({ fileName, localPreview, remotePreview }) {
  return new Promise((resolve) => {
    const backdrop = document.createElement("div");
    backdrop.className = "gdoc-sot-backdrop sync-conflict-backdrop";
    const modal = document.createElement("div");
    modal.className = "gdoc-sot-modal sync-conflict-modal";
    modal.innerHTML = `
      <div class="gdoc-sot-header">Sync conflict</div>
      <div class="gdoc-sot-body">
        <p><strong>${escHtml(fileName || "Untitled")}</strong> was changed
        on another device while you were editing here. Choose which
        version to keep — the other is preserved in Versions so you can
        recover it later.</p>
        <div class="gdoc-sot-options">
          <button class="gdoc-sot-option" data-choice="local">
            <div class="gdoc-sot-option-title">Keep my version</div>
            <div class="gdoc-sot-option-detail">Push this device's content over the remote. The remote version is snapshotted to Versions.</div>
            <pre class="sync-conflict-preview">${escHtml(truncate(localPreview, 800))}</pre>
          </button>
          <button class="gdoc-sot-option" data-choice="remote">
            <div class="gdoc-sot-option-title">Keep the other version</div>
            <div class="gdoc-sot-option-detail">Accept the remote content. This device's local content is snapshotted to Versions.</div>
            <pre class="sync-conflict-preview">${escHtml(truncate(remotePreview, 800))}</pre>
          </button>
        </div>
      </div>
      <div class="gdoc-sot-footer">
        <button class="gdoc-sot-cancel" data-choice="versions">Open Versions instead</button>
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
    modal.querySelectorAll("[data-choice]").forEach((btn) => {
      btn.addEventListener("click", () => close(btn.dataset.choice));
    });
  });
}

function escHtml(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function truncate(s, n) {
  s = String(s ?? "");
  if (s.length <= n) return s;
  return s.slice(0, n) + "\n…";
}
