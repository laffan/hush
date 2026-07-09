#!/usr/bin/env node
/**
 * Link Google ML Kit Digital Ink Recognition into the Tauri-generated
 * iOS project. `tauri ios init` regenerates src-tauri/gen/apple, so
 * this runs right after it (chained in `npm run ios:init`) and is
 * safe to re-run — it's a no-op when the Podfile is already in shape.
 *
 * ML Kit ships via CocoaPods only (no SPM), so it can't ride a Tauri
 * plugin's Swift package; instead the pod links the MLK* classes into
 * the app binary and the Rust side reaches them dynamically
 * (src-tauri/src/commands/handwriting_ink.rs). Without the pod the
 * app still builds — the "G" recognize action just returns an error.
 *
 * Beyond adding the pod, this repairs a Tauri template quirk: the
 * generated Podfile declares both `<app>_iOS` and `<app>_macOS`
 * targets, but `tauri ios init` only puts `<app>_iOS` in the Xcode
 * project, so `pod install` dies with "Unable to find a target named
 * `hush_macOS`". The macOS desktop build doesn't use gen/apple at
 * all (it's a plain cargo bundle), so the phantom macOS target block
 * is removed outright.
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

const original = readFileSync(podfilePath, "utf8");
let podfile = original;

// 1. Drop macOS target blocks — they aren't in the generated Xcode
//    project and make `pod install` fail before installing anything.
//    (Flat non-greedy match: the template's target blocks contain only
//    pod/platform lines, no nested do...end.)
podfile = podfile.replace(
  /^[ \t]*target\s+['"][^'"]*macOS['"]\s+do\b[\s\S]*?^end[ \t]*\n?/gm,
  () => {
    console.log("Removing phantom macOS target block from Podfile (not present in the Xcode project).");
    return "";
  },
);

// 2. Ensure the ML Kit pod sits in every iOS app target (and only
//    there). Strip any previous insertion first so this stays
//    idempotent even if an earlier script version put it elsewhere.
podfile = podfile.replace(new RegExp(`^[ \\t]*${POD_LINE.replace(/[/'.]/g, "\\$&")}[ \\t]*\\n`, "gm"), "");
const iosTarget = /^([ \t]*target\s+['"][^'"]*iOS['"]\s+do[ \t]*)$/gm;
if (!iosTarget.test(podfile)) {
  console.error("Couldn't find an iOS `target ... do` block in the Podfile — add this line to your app target manually:\n  " + POD_LINE);
  process.exit(1);
}
podfile = podfile.replace(iosTarget, `$1\n  ${POD_LINE}`);

// 3. ML Kit needs iOS >= 15.5; raise the platform line if lower.
podfile = podfile.replace(/^([ \t]*platform :ios, ['"])([\d.]+)(['"])/m, (line, pre, ver, post) => {
  if (parseFloat(ver) >= MIN_IOS) return line;
  console.log(`Raising Podfile iOS platform ${ver} -> ${MIN_IOS} (ML Kit minimum).`);
  return `${pre}${MIN_IOS}${post}`;
});

if (podfile !== original) {
  writeFileSync(podfilePath, podfile);
  console.log("Updated " + podfilePath);
} else {
  console.log("Podfile already in shape.");
}

try {
  execSync("pod install", { cwd: appleDir, stdio: "inherit" });
} catch {
  console.error("`pod install` failed — run it manually in src-tauri/gen/apple (requires CocoaPods: `brew install cocoapods`).");
  process.exit(1);
}
