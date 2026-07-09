#!/usr/bin/env node
/**
 * Link Google ML Kit Digital Ink Recognition into the Tauri-generated
 * iOS project. `tauri ios init` regenerates src-tauri/gen/apple, so
 * this runs right after it (chained in `npm run ios:init`) and is
 * safe to re-run — it's a no-op when the pod is already present.
 *
 * ML Kit ships via CocoaPods only (no SPM), so it can't ride a Tauri
 * plugin's Swift package; instead the pod links the MLK* classes into
 * the app binary and the Rust side reaches them dynamically
 * (src-tauri/src/commands/handwriting_ink.rs). Without the pod the
 * app still builds — the "G" recognize action just returns an error.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const POD_LINE = "pod 'GoogleMLKit/DigitalInkRecognition'";
const MIN_IOS = 15.5; // ML Kit's minimum deployment target

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const appleDir = resolve(root, "src-tauri/gen/apple");
const podfilePath = resolve(appleDir, "Podfile");

if (!existsSync(appleDir)) {
  console.error("src-tauri/gen/apple doesn't exist — run `npm run ios:init` first.");
  process.exit(1);
}

if (!existsSync(podfilePath)) {
  console.error(
    "No Podfile in src-tauri/gen/apple. Your Tauri version's iOS template may not use CocoaPods —\n" +
    "create a Podfile there with the app target and add:\n  " + POD_LINE + "\n" +
    "then run `pod install` in that directory.",
  );
  process.exit(1);
}

let podfile = readFileSync(podfilePath, "utf8");
let changed = false;

if (!podfile.includes(POD_LINE)) {
  // Insert into every `target '...' do` block (the template has the
  // iOS app target; inserting into all targets is harmless).
  const before = podfile;
  podfile = podfile.replace(/^([ \t]*target\s+['"][^'"]+['"]\s+do[ \t]*)$/gm, `$1\n  ${POD_LINE}`);
  if (podfile === before) {
    console.error("Couldn't find a `target ... do` block in the Podfile — add this line manually:\n  " + POD_LINE);
    process.exit(1);
  }
  changed = true;
}

// ML Kit needs iOS >= 15.5; raise the Podfile platform line if lower.
podfile = podfile.replace(/^([ \t]*platform :ios, ['"])([\d.]+)(['"])/m, (line, pre, ver, post) => {
  if (parseFloat(ver) >= MIN_IOS) return line;
  changed = true;
  console.log(`Raising Podfile iOS platform ${ver} -> ${MIN_IOS} (ML Kit minimum).`);
  return `${pre}${MIN_IOS}${post}`;
});

if (changed) {
  writeFileSync(podfilePath, podfile);
  console.log("Added ML Kit Digital Ink Recognition to " + podfilePath);
} else {
  console.log("ML Kit pod already present in Podfile.");
}

try {
  execSync("pod install", { cwd: appleDir, stdio: "inherit" });
} catch {
  console.error("`pod install` failed — run it manually in src-tauri/gen/apple (requires CocoaPods: `brew install cocoapods`).");
  process.exit(1);
}
