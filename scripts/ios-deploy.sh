#!/usr/bin/env bash
#
# Build + install Hush to a connected iOS device via ios-deploy, without
# Tauri's archive / exportArchive step.
#
# `tauri ios build` runs `xcodebuild archive` then `xcodebuild
# -exportArchive` to produce a redistributable .ipa. The export step picks
# a managed development provisioning profile and fails if the connected
# device isn't already in it ("...doesn't include the currently selected
# device"). ios-deploy doesn't need that .ipa — it installs a .app bundle
# directly — so we do a plain `xcodebuild build` for the device (which the
# project's "Build Rust Code" phase compiles the Rust lib during) with
# `-allowProvisioningUpdates` so Xcode registers the device and regenerates
# the development profile automatically, then install the built .app.
#
# Requires: a connected, trusted device; `ios-deploy` on PATH; the iOS
# project already generated (`tauri ios init`).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

PROJECT="src-tauri/gen/apple/hush.xcodeproj"
SCHEME="hush_iOS"
CONFIG="debug"
DERIVED="src-tauri/gen/apple/build/ios-deploy"
APP_NAME="Hush.app"

if [[ ! -d "$PROJECT" ]]; then
  echo "✗ $PROJECT not found — run 'npm run tauri ios init' first." >&2
  exit 1
fi
if ! command -v ios-deploy >/dev/null 2>&1; then
  echo "✗ ios-deploy not found on PATH (brew install ios-deploy)." >&2
  exit 1
fi

# 1. Frontend bundle — Tauri normally runs this as its beforeBuildCommand;
#    xcodebuild on its own won't, so do it here.
echo "▸ Building frontend (npm run build)…"
npm run build

# 2. Resolve the connected device's UDID so we can target it directly.
#    Building against a specific device id is what lets automatic signing
#    register that device into the development profile. Falls back to a
#    generic iOS destination if no device is detected.
echo "▸ Detecting connected device…"
UDID="$(ios-deploy -c -t 1 2>/dev/null \
  | sed -n 's/.*Found \([0-9A-Fa-f][0-9A-Fa-f-]\{24,\}\).*/\1/p' \
  | head -n1 || true)"
if [[ -n "$UDID" ]]; then
  echo "  device: $UDID"
  DESTINATION="platform=iOS,id=$UDID"
else
  echo "  no device detected via ios-deploy — using a generic iOS destination."
  DESTINATION="generic/platform=iOS"
fi

# 3. Build the .app for the device (no archive, no exportArchive).
echo "▸ Building app with xcodebuild…"
xcodebuild build \
  -project "$PROJECT" \
  -scheme "$SCHEME" \
  -configuration "$CONFIG" \
  -destination "$DESTINATION" \
  -derivedDataPath "$DERIVED" \
  -allowProvisioningUpdates

# 4. Locate the freshly built bundle and install it.
APP="$(find "$DERIVED/Build/Products" -maxdepth 2 -name "$APP_NAME" -type d 2>/dev/null | head -n1 || true)"
if [[ -z "$APP" ]]; then
  echo "✗ Could not find $APP_NAME under $DERIVED/Build/Products." >&2
  echo "  Check that the scheme ('$SCHEME') and configuration ('$CONFIG') are correct" >&2
  echo "  with: xcodebuild -list -project $PROJECT" >&2
  exit 1
fi

echo "▸ Installing $APP …"
# --justlaunch returns once the app is launched instead of attaching the
# debugger; drop it (or swap for --debug) if you want lldb / live logs.
ios-deploy --bundle "$APP" --no-wifi --justlaunch

echo "✓ Done."
