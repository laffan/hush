import { defineConfig } from "vite";
import { resolve } from "path";

// `tauri ios dev` (and `tauri android dev`) sets `TAURI_DEV_HOST` to
// the Mac's LAN IP and expects the dev server to be reachable there
// so the iPad / Android device can fetch the bundle. Without this,
// Vite listens on 127.0.0.1 only and the device sees a hang.
const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  clearScreen: false,
  server: {
    host: host || false,
    port: 5173,
    strictPort: true,
    hmr: host ? { protocol: "ws", host, port: 5174 } : undefined,
  },
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
