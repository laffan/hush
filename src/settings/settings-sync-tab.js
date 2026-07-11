/**
 * Settings Sync tab bindings — extracted from settings-window.js.
 * Sub-tabs: Google Sync (OAuth connect / credentials / disconnect),
 * iCloud (debug), and the sync Log. Dropbox sync was removed — see
 * LOCAL-DESKS-PLANNING.md; folder-based desks replace it.
 */

const IS_TAURI = typeof window !== "undefined" && window.__TAURI_INTERNALS__;

/**
 * Bind all Sync tab UI controls.
 * @param {Function} saveSetting - Async function to persist a setting key/value.
 * @param {Object} settings - Current settings object (mutated in place).
 * @param {Function} render - Re-render the settings UI.
 */
export function bindSyncTab(saveSetting, settings, render) {

  // Sub-tab nav switching (Google / iCloud / Log).
  document.querySelectorAll(".sync-subtab").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.dataset.syncSubtab;
      const { setSyncSubTab } = await import("./settings-tabs-sync.js");
      setSyncSubTab(id);
      render();
    });
  });

  // ===== Google Sync sub-tab =====
  bindGoogleSubTab(saveSetting, settings, render);

  // ===== iCloud (debug) sub-tab =====
  import("./settings-tabs-icloud.js").then((m) => m.bindICloudSubTab()).catch(() => {});

  // ===== Log sub-tab =====
  const clearSyncLogBtn = document.getElementById("sync-clear-log");
  if (clearSyncLogBtn) {
    clearSyncLogBtn.addEventListener("click", async () => {
      await saveSetting("syncLog", []);
      render();
    });
  }

  // Handle OAuth callback (deep link returns with auth code). The
  // sessionStorage `hush_oauth_provider` flag was set when the flow
  // started so we know the pending provider (Google is the only one).
  if (IS_TAURI) {
    const verifier = sessionStorage.getItem("hush_oauth_verifier");
    if (verifier) {
      const urlParams = new URLSearchParams(window.location.search);
      const code = urlParams.get("code");
      if (code) {
        sessionStorage.removeItem("hush_oauth_verifier");
        sessionStorage.removeItem("hush_oauth_provider");
        (async () => {
          try {
            const mod = await import("../google-docs/auth.js");
            const redirectUri = sessionStorage.getItem("hush_oauth_redirect") || mod.getRedirectUri();
            sessionStorage.removeItem("hush_oauth_redirect");
            await mod.completeOAuthFlow(code, verifier, redirectUri);
            const { invoke } = await import("@tauri-apps/api/core");
            const newSettings = await invoke("get_settings");
            Object.assign(settings, newSettings);
            render();
          } catch (e) {
            console.error("OAuth completion failed:", e);
          }
        })();
      }
    }
  }
}

// ===== Google sub-tab bindings =====

function bindGoogleSubTab(saveSetting, settings, render) {
  // ===== Credential form (Save / Cancel) =====
  // The form surfaces either when no client id is saved or when the
  // user clicked "Edit credentials". Save persists both fields (a blank
  // secret means "keep what's stored") then flips back to the normal
  // connect / connected view.
  const credsSaveBtn = document.getElementById("google-creds-save");
  if (credsSaveBtn) {
    credsSaveBtn.addEventListener("click", async () => {
      const idEl = document.getElementById("google-client-id");
      const secretEl = document.getElementById("google-client-secret");
      const id = (idEl?.value || "").trim();
      const status = document.getElementById("google-auth-status");
      if (!id) {
        if (status) { status.textContent = "Client ID is required."; status.className = "sync-status error"; }
        idEl?.focus();
        return;
      }
      const rawSecret = secretEl?.value || "";
      const isMask = rawSecret === "••••••••";
      const secret = isMask ? (settings.googleClientSecret || "") : rawSecret.trim();
      await saveSetting("googleClientId", id);
      await saveSetting("googleClientSecret", secret);
      // Tell auth.js's in-memory cache to re-read from settings.
      try {
        const auth = await import("../google-docs/auth.js");
        auth.setClientId(id);
      } catch (_) {}
      const { setEditingGoogleCreds } = await import("./settings-tabs-sync.js");
      setEditingGoogleCreds(false);
      render();
    });
  }
  const credsCancelBtn = document.getElementById("google-creds-cancel");
  if (credsCancelBtn) {
    credsCancelBtn.addEventListener("click", async () => {
      const { setEditingGoogleCreds } = await import("./settings-tabs-sync.js");
      setEditingGoogleCreds(false);
      render();
    });
  }
  const editCredsBtn = document.getElementById("google-edit-credentials");
  if (editCredsBtn) {
    editCredsBtn.addEventListener("click", async () => {
      const { setEditingGoogleCreds } = await import("./settings-tabs-sync.js");
      setEditingGoogleCreds(true);
      render();
    });
  }

  // Connect: starts the OAuth PKCE flow, listens for the callback event,
  // refreshes settings on completion.
  const connectBtn = document.getElementById("google-connect");
  if (connectBtn) {
    connectBtn.addEventListener("click", async () => {
      const status = document.getElementById("google-auth-status");
      if (status) { status.textContent = "Opening Google sign-in…"; status.className = "sync-status"; }
      try {
        const auth = await import("../google-docs/auth.js");
        const { codeVerifier, redirectUri } = await auth.startOAuthFlow();
        sessionStorage.setItem("hush_oauth_verifier", codeVerifier);
        sessionStorage.setItem("hush_oauth_redirect", redirectUri);
        sessionStorage.setItem("hush_oauth_provider", "google");
        if (status) { status.textContent = "Waiting for Google authorization…"; }
        if (IS_TAURI) {
          const { listen } = await import("@tauri-apps/api/event");
          const unlisten = await listen("oauth-callback", async (event) => {
            const { code, provider } = event.payload || {};
            if (!code || provider !== "google") return;
            unlisten();
            if (status) { status.textContent = "Completing authorization…"; }
            try {
              const verifier = sessionStorage.getItem("hush_oauth_verifier");
              const ru = sessionStorage.getItem("hush_oauth_redirect") || auth.getRedirectUri();
              sessionStorage.removeItem("hush_oauth_verifier");
              sessionStorage.removeItem("hush_oauth_redirect");
              sessionStorage.removeItem("hush_oauth_provider");
              await auth.completeOAuthFlow(code, verifier, ru);
              const { invoke } = await import("@tauri-apps/api/core");
              const newSettings = await invoke("get_settings");
              Object.assign(settings, newSettings);
              if (status) { status.textContent = "Connected!"; status.className = "sync-status success"; }
              setTimeout(() => render(), 800);
            } catch (err) {
              console.error("Google OAuth completion failed:", err);
              if (status) { status.textContent = "Authorization failed: " + err.message; status.className = "sync-status error"; }
            }
          });
          setTimeout(() => unlisten(), 300000);
        }
      } catch (e) {
        console.error("Google OAuth start failed:", e);
        if (status) { status.textContent = "Failed to start: " + e.message; status.className = "sync-status error"; }
      }
    });
  }

  const testBtn = document.getElementById("google-test-connection");
  if (testBtn) {
    testBtn.addEventListener("click", async () => {
      const status = document.getElementById("google-auth-status");
      const statusVal = document.getElementById("google-connection-status");
      if (status) { status.textContent = "Testing…"; status.className = "sync-status"; }
      try {
        const auth = await import("../google-docs/auth.js");
        const result = await auth.testConnection();
        if (result.ok) {
          if (status) { status.textContent = `Connected as ${result.email || "Google account"}`; status.className = "sync-status success"; }
          if (statusVal) statusVal.textContent = "Connected";
        } else {
          if (status) { status.textContent = "Connection failed: " + result.error; status.className = "sync-status error"; }
          if (statusVal) statusVal.textContent = "Disconnected";
        }
      } catch (e) {
        if (status) { status.textContent = "Connection failed."; status.className = "sync-status error"; }
        if (statusVal) statusVal.textContent = "Error";
      }
    });
  }

  const disconnectBtn = document.getElementById("google-disconnect");
  if (disconnectBtn) {
    disconnectBtn.addEventListener("click", async () => {
      const ok = window.confirm(
        "Disconnect the Google account?\n\n" +
        "This revokes the access token, clears stored credentials, and " +
        "forgets every per-document link. The Google Docs themselves are untouched."
      );
      if (!ok) return;
      const auth = await import("../google-docs/auth.js");
      await auth.disconnect();
      const { invoke } = await import("@tauri-apps/api/core");
      const newSettings = await invoke("get_settings");
      Object.assign(settings, newSettings);
      render();
    });
  }

  const clearLogBtn = document.getElementById("google-clear-log");
  if (clearLogBtn) {
    clearLogBtn.addEventListener("click", async () => {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("clear_google_sync_log");
      const newSettings = await invoke("get_settings");
      Object.assign(settings, newSettings);
      render();
    });
  }
}
