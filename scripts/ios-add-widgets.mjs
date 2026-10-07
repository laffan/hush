#!/usr/bin/env node
/**
 * Add the home screen widget extension to the Tauri-generated iOS
 * project. Opt-in, because it adds an App Group to the app's signature —
 * a capability your Apple Developer team has to be able to provision —
 * and a build that can't sign it can't install at all. Run it after
 * `npm run ios:init` (which regenerates src-tauri/gen/apple and so drops
 * it again):
 *
 *   npm run ios:init && npm run ios:add-widgets
 *
 * Safe to re-run: everything it adds is fenced by markers and replaced,
 * not stacked.
 *
 * What it does (see widgets/README-WIDGETS.md for the why):
 *   1. Adds a `HushWidgets` app-extension target to gen/apple/project.yml
 *      (the XcodeGen spec Tauri generates the project from), built from
 *      widgets/Sources and embedded in the app.
 *   2. Gives the app and the extension the same App Group
 *      (HUSH_APP_GROUP), through which the app hands the widgets their
 *      snapshot (tauri-plugin-hush-widgets) — the extension's Info.plist
 *      carries it as `HushAppGroup`.
 *   3. Regenerates the Xcode project with `xcodegen`, then re-runs
 *      `pod install`, since regenerating drops the CocoaPods integration
 *      ios-add-mlkit-pod.mjs set up.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { execSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Must match IOS_APP_GROUP in src-tauri/src/widgets.rs. */
const HUSH_APP_GROUP = "group.com.hushwriter.app";
const TARGET = "HushWidgets";
/** WidgetKit's configurable widgets (App Intents) and containerBackground
 *  are iOS 17 APIs. The app keeps its own floor; on an older system the
 *  app installs and the widgets simply aren't offered. */
const WIDGET_IOS_FLOOR = "17.0";

const BEGIN = "# hush-widgets BEGIN — managed by scripts/ios-add-widgets.mjs";
const END = "# hush-widgets END";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const appleDir = resolve(root, "src-tauri/gen/apple");
const specPath = resolve(appleDir, "project.yml");

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

if (!existsSync(specPath)) {
  fail("src-tauri/gen/apple/project.yml doesn't exist — run `npm run ios:init` first.");
}

const conf = JSON.parse(readFileSync(resolve(root, "src-tauri/tauri.conf.json"), "utf8"));
const appId = conf.identifier;
if (!appId) fail("src-tauri/tauri.conf.json has no `identifier`.");

const original = readFileSync(specPath, "utf8");
let spec = original;

// Drop anything an earlier run added, so the rest can assume a clean spec.
spec = spec.replace(new RegExp(`^[ \\t]*${BEGIN}[\\s\\S]*?^[ \\t]*${END}[ \\t]*\\n?`, "gm"), "");
spec = spec.replace(/^[ \t]*- target: HushWidgets[^\n]*\n/gm, "");

// The app target is the one Tauri names <app>_iOS.
const appTargetMatch = spec.match(/^  ([A-Za-z0-9_-]+_iOS):\s*$/m);
if (!appTargetMatch) fail("Couldn't find the `<app>_iOS` target in project.yml.");
const appTarget = appTargetMatch[1];

// Versions must match the app's, or App Store validation refuses the
// bundle; the team must match for automatic signing to embed it.
const shortVersion = (spec.match(/^\s*CFBundleShortVersionString:\s*(.+)$/m) || [])[1]?.trim() || "1.0";
const bundleVersion = (spec.match(/^\s*CFBundleVersion:\s*(.+)$/m) || [])[1]?.trim() || "\"1\"";
const team = (spec.match(/^\s*DEVELOPMENT_TEAM:\s*(.+)$/m) || [])[1]?.trim() || null;

// 1. Embed the extension in the app: a dependency on the app target.
//    Its `dependencies:` list is the first one in the spec.
const depsRe = /^(    dependencies:\s*\n)/m;
if (!depsRe.test(spec)) fail(`Couldn't find ${appTarget}'s dependencies list in project.yml.`);
spec = spec.replace(depsRe, `$1      - target: ${TARGET} # hush-widgets\n`);

// 2. The extension target. `targets:` is the spec's last section, so the
//    block goes at the end, indented as one of its entries.
const block = `
  ${BEGIN}
  ${TARGET}:
    type: app-extension
    platform: iOS
    deploymentTarget: "${WIDGET_IOS_FLOOR}"
    sources:
      - path: ../../../widgets/Sources
    info:
      path: ${TARGET}/Info.plist
      properties:
        CFBundleDisplayName: Hush
        CFBundleShortVersionString: ${shortVersion}
        CFBundleVersion: ${bundleVersion}
        HushAppGroup: ${HUSH_APP_GROUP}
        NSExtension:
          NSExtensionPointIdentifier: com.apple.widgetkit-extension
    entitlements:
      path: ${TARGET}/${TARGET}.entitlements
      properties:
        com.apple.security.application-groups:
          - ${HUSH_APP_GROUP}
    settings:
      base:
        PRODUCT_NAME: ${TARGET}
        PRODUCT_BUNDLE_IDENTIFIER: ${appId}.widgets
        TARGETED_DEVICE_FAMILY: "1,2"
        SWIFT_VERSION: "5.0"
        SKIP_INSTALL: true
        GENERATE_INFOPLIST_FILE: false${team ? `\n        DEVELOPMENT_TEAM: ${team}` : ""}
    dependencies:
      - sdk: WidgetKit.framework
      - sdk: SwiftUI.framework
      - sdk: AppIntents.framework
  ${END}
`;
spec = spec.replace(/\s*$/, "\n") + block;

if (spec !== original) {
  writeFileSync(specPath, spec);
  console.log(`Added the ${TARGET} extension to ${specPath}`);
} else {
  console.log("project.yml already has the widget extension.");
}

// 3. The app's own entitlements gain the App Group. The spec only names
//    the file (no properties), so XcodeGen leaves its contents alone —
//    edit the plist itself, keeping whatever else it holds.
const entPath = resolve(appleDir, `${appTarget}/${appTarget}.entitlements`);
const EMPTY_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
</dict>
</plist>
`;
let ent = existsSync(entPath) ? readFileSync(entPath, "utf8") : EMPTY_PLIST;
if (!ent.includes(HUSH_APP_GROUP)) {
  if (ent.includes("com.apple.security.application-groups")) {
    // An App Group list already exists — add ours to it.
    ent = ent.replace(
      /(<key>com\.apple\.security\.application-groups<\/key>\s*<array>)/,
      `$1\n\t\t<string>${HUSH_APP_GROUP}</string>`,
    );
  } else if (/<dict\s*\/>/.test(ent)) {
    ent = ent.replace(/<dict\s*\/>/, `<dict>\n\t<key>com.apple.security.application-groups</key>\n\t<array>\n\t\t<string>${HUSH_APP_GROUP}</string>\n\t</array>\n</dict>`);
  } else {
    ent = ent.replace(
      /<\/dict>\s*<\/plist>\s*$/,
      `\t<key>com.apple.security.application-groups</key>\n\t<array>\n\t\t<string>${HUSH_APP_GROUP}</string>\n\t</array>\n</dict>\n</plist>\n`,
    );
  }
  mkdirSync(dirname(entPath), { recursive: true });
  writeFileSync(entPath, ent);
  console.log(`Added ${HUSH_APP_GROUP} to ${entPath}`);
}

// 4. Regenerate the Xcode project, then put CocoaPods back on it.
try {
  execSync("xcodegen generate", { cwd: appleDir, stdio: "inherit" });
} catch {
  fail("`xcodegen generate` failed — install XcodeGen (`brew install xcodegen`, which `tauri ios init` needs too) and re-run.");
}
if (existsSync(resolve(appleDir, "Podfile"))) {
  try {
    execSync("pod install", { cwd: appleDir, stdio: "inherit" });
  } catch {
    fail("`pod install` failed — run it manually in src-tauri/gen/apple.");
  }
}
console.log(`\nDone. In Xcode, check that ${TARGET} signs with your team and that the App Group\n` +
  `${HUSH_APP_GROUP} is enabled for both ${appTarget} and ${TARGET}.`);
