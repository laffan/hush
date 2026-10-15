import { defineConfig } from "vite";
import { resolve } from "path";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

// `src/build-info.generated.js` is written by scripts/gen-build-info.mjs
// and git-ignored, so a fresh checkout has no copy of it. The npm
// scripts generate it, but `vite`/`vite build` invoked directly (an IDE
// task, `npx vite`) would fail to resolve the import — regenerate it
// here too so the file is never missing.
const buildInfoPlugin = {
  name: "hush-build-info",
  buildStart() {
    try {
      execFileSync("node", [resolve(__dirname, "scripts/gen-build-info.mjs")], {
        stdio: "inherit",
        env: { ...process.env, HUSH_BUILD_INFO_QUIET: "1" },
      });
    } catch (e) {
      this.warn(`build-info stamp failed: ${e.message}`);
    }
  },
};

// pdf.js loads some of what it needs by URL at run time: the
// WebAssembly JBIG2 / JPEG 2000 decoders (without them a scanned PDF —
// whose pages are exactly those images — renders blank), ICC profiles,
// standard fonts and CMaps. This serves those directories of pdfjs-dist
// under /pdfjs/ in dev and copies them into the build;
// src/pdf/pdfjs-loader.js points every getDocument call at them.
const PDFJS_DIRS = ["wasm", "iccs", "standard_fonts", "cmaps"];
const PDFJS_ROOT = resolve(__dirname, "node_modules/pdfjs-dist");
const pdfjsAssetsPlugin = {
  name: "hush-pdfjs-assets",
  configureServer(server) {
    server.middlewares.use("/pdfjs", (req, res, next) => {
      const [dir, file] = decodeURIComponent((req.url || "").split("?")[0]).replace(/^\//, "").split("/");
      if (!PDFJS_DIRS.includes(dir) || !file || file.includes("..")) return next();
      const full = path.join(PDFJS_ROOT, dir, file);
      if (!fs.existsSync(full)) return next();
      const type = file.endsWith(".wasm") ? "application/wasm"
        : file.endsWith(".js") ? "text/javascript" : "application/octet-stream";
      res.setHeader("Content-Type", type);
      fs.createReadStream(full).pipe(res);
    });
  },
  generateBundle() {
    for (const dir of PDFJS_DIRS) {
      for (const file of fs.readdirSync(path.join(PDFJS_ROOT, dir))) {
        this.emitFile({ type: "asset", fileName: `pdfjs/${dir}/${file}`, source: fs.readFileSync(path.join(PDFJS_ROOT, dir, file)) });
      }
    }
  },
};

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
  plugins: [buildInfoPlugin, pdfjsAssetsPlugin],
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
      },
    },
  },
});
