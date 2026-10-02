/**
 * Zotero settings tab — credentials, reference download, and PDF
 * snapshot tuning. Extracted from settings-tabs.js.
 */

import { escAttr } from "./settings-tabs.js";

export function renderZoteroTab(settings) {
  const s = settings;
  const hasCredentials = s.zoteroApiKey && s.zoteroUserId;
  const hasRefs = s.zoteroReferenceCount > 0;
  const hasHighlights = !!s.zoteroHighlightsLastUpdate;
  return `
    <div class="settings-section">
      <h2>Zotero API</h2>
      <p class="settings-help">
        Enter your Zotero User ID and API Key to connect your library.
        Create an API key at <a href="https://www.zotero.org/settings/keys" target="_blank" style="color: inherit; text-decoration: underline;">zotero.org/settings/keys</a>.
      </p>
      <div class="zotero-credentials">
        <div class="settings-row">
          <label>User ID</label>
          <input type="text" id="zotero-user-id" placeholder="e.g. 12345678" value="${escAttr(s.zoteroUserId || "")}" />
        </div>
        <div class="settings-row">
          <label>API Key</label>
          <input type="password" id="zotero-api-key" placeholder="Zotero API key" value="${escAttr(s.zoteroApiKey || "")}" />
        </div>
        <button id="zotero-test-btn" class="zotero-test-btn">Test Connection</button>
        <div id="zotero-test-status" class="zotero-status"></div>
      </div>
    </div>
    <div class="settings-section">
      <h2>References</h2>
      ${zoteroProgress("references")}
      ${hasRefs ? `
        <div class="zotero-ref-info">
          <strong>${s.zoteroReferenceCount}</strong> reference${s.zoteroReferenceCount !== 1 ? "s" : ""}
          ${s.zoteroLastUpdate ? `<br/><span class="zotero-ref-detail">Last updated: ${s.zoteroLastUpdate}</span>` : ""}
          ${s.zoteroFileSize ? `<br/><span class="zotero-ref-detail">File size: ${s.zoteroFileSize}</span>` : ""}
        </div>
      ` : ""}
      <button id="zotero-download-references" class="zotero-download-btn" ${!hasCredentials ? "disabled" : ""}>
        ${hasRefs ? "Update References" : "Download References"}
      </button>
    </div>
    <div class="settings-section">
      <h2>Highlights</h2>
      <p class="settings-help">
        Every highlight in your library, in a file of its own. With it on this device the highlight browser opens a paper's highlights without asking Zotero.
      </p>
      ${zoteroProgress("highlights")}
      ${hasHighlights ? `
        <div class="zotero-ref-info">
          <strong>${s.zoteroHighlightCount}</strong> highlight${s.zoteroHighlightCount !== 1 ? "s" : ""}
          <br/><span class="zotero-ref-detail">Last updated: ${s.zoteroHighlightsLastUpdate}</span>
          ${s.zoteroHighlightsFileSize ? `<br/><span class="zotero-ref-detail">File size: ${s.zoteroHighlightsFileSize}</span>` : ""}
        </div>
      ` : ""}
      <button id="zotero-download-highlights" class="zotero-download-btn" ${!hasCredentials ? "disabled" : ""}>
        ${hasHighlights ? "Update Highlights" : "Download Highlights"}
      </button>
    </div>
    <div class="settings-section">
      <h2>PDF Snapshots</h2>
      <p class="settings-help">
        When inserting a Zotero PDF reference with the Insert snapshot option, the chosen page is rendered to an image at this size.
      </p>
      <div class="settings-row">
        <label>Render height (px)</label>
        <input type="number" id="zotero-snapshot-render-height" min="100" max="6000" step="50" value="${s.zoteroSnapshotRenderHeight ?? 1500}" />
      </div>
      <div class="settings-row">
        <label>Display height (px)</label>
        <input type="number" id="zotero-snapshot-display-height" min="50" max="2000" step="10" value="${s.zoteroSnapshotDisplayHeight ?? 300}" />
      </div>
      <div class="settings-row">
        <label>WebP quality (1–100)</label>
        <input type="number" id="zotero-snapshot-quality" min="1" max="100" step="1" value="${s.zoteroSnapshotQuality ?? 90}" />
      </div>
    </div>
  `;
}

/** A download's progress bar, its message and its Cancel — hidden until
 *  that download runs (settings/settings-zotero.js). */
function zoteroProgress(job) {
  return `
      <div class="zotero-progress" data-zotero-job="${job}" style="display:none;">
        <div class="zotero-progress-bar"><div class="zotero-progress-fill"></div></div>
        <div class="zotero-progress-row">
          <div class="zotero-progress-text"></div>
          <button type="button" class="zotero-cancel-btn">Cancel</button>
        </div>
      </div>`;
}
