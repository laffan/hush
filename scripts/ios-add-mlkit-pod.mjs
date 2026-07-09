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

// 3. Keep Tauri's Rust staticlib linkable. The generated project finds
//    libapp.a via an arch-conditional build setting
//    (LIBRARY_SEARCH_PATHS[arch=arm64] -> $(PROJECT_DIR)/Externals/...),
//    which stops matching once CocoaPods layers its base xcconfig in
//    (Xcode resolves the link step with arch=undefined_arch), so the
//    app dies with "ld: library 'app' not found". Patch the generated
//    Pods xcconfig from post_install to re-add the path unconditionally.
const MLKIT_HOOK = `  # hush-mlkit: CocoaPods' base xcconfig shadows the arch-conditional
  # LIBRARY_SEARCH_PATHS pointing at Tauri's Rust staticlib
  # (Externals/<arch>/<config>/libapp.a), which breaks the link with
  # "library 'app' not found". Re-add the path unconditionally.
  installer.aggregate_targets.each do |agg|
    agg.user_build_configurations.each_key do |config_name|
      xcconfig_path = agg.xcconfig_path(config_name)
      next unless File.exist?(xcconfig_path)
      text = File.read(xcconfig_path)
      next if text.include?('/Externals/')
      extra = ' "$(PROJECT_DIR)/Externals/arm64/$(CONFIGURATION)" "$(PROJECT_DIR)/Externals/x86_64/$(CONFIGURATION)"'
      if text =~ /^LIBRARY_SEARCH_PATHS = .*$/
        text = text.sub(/^LIBRARY_SEARCH_PATHS = .*$/) { |line| line + extra }
      else
        text += "\\nLIBRARY_SEARCH_PATHS = $(inherited)#{extra}\\n"
      end
      File.write(xcconfig_path, text)
    end
  end
`;
if (!podfile.includes("hush-mlkit:")) {
  if (/^post_install do \|installer\|[ \t]*$/m.test(podfile)) {
    // Merge into the template's existing hook — CocoaPods allows only
    // one post_install per Podfile.
    podfile = podfile.replace(/^(post_install do \|installer\|[ \t]*)$/m, `$1\n${MLKIT_HOOK}`);
  } else {
    podfile += `\npost_install do |installer|\n${MLKIT_HOOK}end\n`;
  }
  console.log("Adding post_install patch that keeps Tauri's Rust staticlib search path.");
}

// 4. ML Kit needs iOS >= 15.5; raise the platform line if lower.
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
