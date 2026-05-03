#!/usr/bin/env node
/**
 * Copies the Hunspell aff / dic files out of `dictionary-en`'s npm
 * package and into `src/assets/dictionaries/` so the editor's spellcheck
 * plugin can import them via Vite's `?url` asset query without fighting
 * the package's strict `exports` map (which only re-exports the JS
 * entry point, and that entry point uses `node:fs/promises` so it can't
 * load the data inside WKWebView anyway).
 *
 * Wired into `package.json`'s `postinstall` so a fresh `npm install`
 * leaves the assets in place. Soft-fails if `node_modules/dictionary-en`
 * hasn't been installed yet — the spellcheck plugin will surface a clear
 * console error instead of decorating nothing.
 */
import { copyFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..");
const srcDir = resolve(repo, "node_modules/dictionary-en");
const destDir = resolve(repo, "src/assets/dictionaries");

if (!existsSync(srcDir) || !statSync(srcDir).isDirectory()) {
  console.warn(
    "[copy-dictionaries] dictionary-en is not installed; skipping. " +
    "Spellcheck will report a missing-dictionary error until you run npm install."
  );
  process.exit(0);
}

mkdirSync(destDir, { recursive: true });

for (const [from, to] of [
  ["index.aff", "en.aff"],
  ["index.dic", "en.dic"],
]) {
  const srcFile = resolve(srcDir, from);
  const destFile = resolve(destDir, to);
  if (!existsSync(srcFile)) {
    console.warn(`[copy-dictionaries] missing ${srcFile}; spellcheck won't load.`);
    continue;
  }
  copyFileSync(srcFile, destFile);
}

console.log("[copy-dictionaries] copied en.aff + en.dic to src/assets/dictionaries/");
