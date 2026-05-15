/**
 * Tauri event listeners for sync-from-settings actions. Extracted from
 * `main.js` so that file stays under the 700-line build cap.
 *
 * Events handled:
 *   * `dropbox-sync-start` — settings window posts here after the user
 *     picks a sync folder. Runs `performInitialSync` under the
 *     initial-sync barrier so the polling cycle can't race the upload
 *     phase, then starts the cursor poll + drain.
 *   * `dropbox-sync-stop` — disconnect path. Stops polling + clears
 *     the cursor / tokens.
 *   * `clear-local-data-request` — the "Clear local versions" recovery
 *     flow. Wipes local files and reseeds from Dropbox.
 *   * `force-sync-request` — the "Force sync now" button.
 *   * `sync-trigger-drain` — the "Retry now" button under the pending
 *     sync queue. Re-runs the op-log drain.
 *
 * The async-import-everything style here matches the rest of main.js:
 * each handler resolves its dependencies inline so the sync layer
 * isn't paid for at boot if the user never enables sync.
 */

export async function wireSyncEventBindings(state) {
  const { listen } = await import("@tauri-apps/api/event");

  await listen("dropbox-sync-start", async (event) => {
    const { path } = event.payload || {};
    if (!path) return;
    // Barrier blocks the cursor cycle (already armed by the prior
    // settings-changed event) so it can't race performInitialSync's
    // download phase and create duplicate `synced_files` rows.
    const sp = await import("./sync-polling.js");
    sp.setInitialSyncBarrier(true);
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      state.settings = await invoke("get_settings");
      const dbx = await import("./dropbox.js");
      if (state.settings.dropboxAccessToken) {
        dbx.setTokens(state.settings.dropboxAccessToken, state.settings.dropboxRefreshToken);
      }
      const { performInitialSync } = await import("./sync-state.js");
      const result = await performInitialSync(state, path);
      const logEntries = [
        ...result.uploaded.map((f) => `Uploaded ${f}`),
        ...result.downloaded.map((f) => `Downloaded ${f}`),
      ];
      if (logEntries.length > 0) {
        const s = await invoke("get_settings");
        const log = s.dropboxSyncLog || [];
        const ts = new Date().toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
        for (const entry of logEntries) log.push(`${ts}  ${entry}`);
        if (log.length > 50) log.splice(0, log.length - 50);
        s.dropboxSyncLog = log;
        await invoke("save_settings", { settings: s });
      }
      sp.startSyncPolling(state);
    } catch (e) {
      console.error("Initial sync failed:", e);
    } finally {
      // Release — the barrier setter kicks an immediate cycle + drain
      // so anything queued during the barrier window catches up.
      sp.setInitialSyncBarrier(false);
    }
  });

  await listen("dropbox-sync-stop", async (event) => {
    const { removeFromDropbox } = event.payload || {};
    try {
      const sp = await import("./sync-polling.js");
      sp.stopSyncPolling();
      const { disconnectSync } = await import("./sync-state.js");
      await disconnectSync(state, removeFromDropbox);
    } catch (e) {
      console.error("Sync disconnect failed:", e);
    }
  });

  await listen("clear-local-data-request", async () => {
    try { await (await import("./sync-state.js")).clearLocalAndReseed(state); }
    catch (e) { console.error("Clear local data failed:", e); }
  });

  await listen("force-sync-request", async () => {
    try { await (await import("./sync-polling.js")).runForceSync(state); }
    catch (e) { console.error("Force sync failed:", e); }
  });

  await listen("sync-trigger-drain", async () => {
    try {
      const { triggerDrain } = await import("./op-log.js");
      triggerDrain(state);
    } catch (e) { console.warn("sync-trigger-drain failed:", e); }
  });
}
