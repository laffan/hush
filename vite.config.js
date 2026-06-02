import { defineConfig } from "vite";
import { resolve } from "path";

// `tauri ios dev` (and `tauri android dev`) sets `TAURI_DEV_HOST` to
// the Mac's LAN IP and expects the dev server to be reachable there
// so the iPad / Android device can fetch the bundle. Build / desktop
// dev paths stay on the original loopback-only config so nothing in
// the production build pipeline is touched.
const tauriHost = process.env.TAURI_DEV_HOST;
const server = tauriHost
  ? { host: tauriHost, port: 5173, strictPort: true, hmr: { protocol: "ws", host: tauriHost, port: 5174 } }
  : { port: 5173, strictPort: true };

export default defineConfig({
  clearScreen: false,
  server,
  envPrefix: ["VITE_", "TAURI_"],
  build: {
    target: ["es2021", "chrome100", "safari15"],
    minify: !process.env.TAURI_DEBUG ? "esbuild" : false,
    sourcemap: !!process.env.TAURI_DEBUG,
    outDir: "dist",
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        settings: resolve(__dirname, "settings.html"),
        "oauth-callback": resolve(__dirname, "oauth-callback.html"),
      },
    },
  },
});
