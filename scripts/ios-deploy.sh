#!/usr/bin/env bash
#
# Build Hush for iOS via Tauri and install it on a connected device with
# ios-deploy — skipping Tauri's exportArchive step.
#
# Why not just call xcodebuild ourselves: the project's "Build Rust Code"
# phase runs `tauri ios xcode-script`, which connects back to the
# orchestrating `tauri ios` process over a local socket to read its build
# options. Run under a bare `xcodebuild` there's nothing listening and it
# panics ("failed to read CLI options ... Connection refused"). So Tauri has
# to drive the build.
#
# What we skip is only the final `xcodebuild -exportArchive` step — the part
# that fails with "provisioning profile doesn't include the currently
# selected device". `tauri ios build` runs `archive` first, producing a
# development-signed Hush.app; ios-deploy installs that .app directly and
# never needs the exported .ipa. So we let the build run (its export step is
# expected to fail), then find the archived .app and install it.
#
# Requirements for the install to succeed: the iPhone must be connected,
# unlocked, trusted, and registered with your Apple Developer team (the
# embedded development profile has to list its UDID). Plug it in BEFORE
# running.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if ! command -v ios-deploy >/dev/null 2>&1; then
  echo "✗ ios-deploy not found on PATH (brew install ios-deploy)." >&2
  exit 1
fi

# Reference timestamp so we only pick up an app built by THIS run.
STAMP="$(mktemp -t hush-ios-deploy)"
cleanup() { rm -f "$STAMP"; }
trap cleanup EXIT

echo "▸ Building + archiving with Tauri…"
echo "  (the exportArchive step at the very end is expected to fail — that's fine)"
set +e
npm run tauri -- ios build --debug
TAURI_STATUS=$?
set -e

# Tauri's archive produces the signed .app even though the later
# exportArchive fails. Grab the newest Hush.app this run created (inside the
# .xcarchive or the build products dir — either is a valid signed bundle).
echo "▸ Locating the freshly built Hush.app…"
APP="$(find src-tauri/gen/apple -type d -name 'Hush.app' -newer "$STAMP" 2>/dev/null \
        -exec stat -f '%m %N' {} \; | sort -rn | head -n1 | cut -d' ' -f2-)"

if [[ -z "${APP:-}" || ! -d "$APP" ]]; then
  echo "✗ No freshly built Hush.app found." >&2
  if [[ "$TAURI_STATUS" -ne 0 ]]; then
    echo "  Tauri likely failed BEFORE archiving (exit $TAURI_STATUS), so the error" >&2
    echo "  above is the real blocker — not the export step. Usual causes: the Rust" >&2
    echo "  build failed, or no signing team is set on the hush_iOS target." >&2
  fi
  exit 1
fi

echo "▸ Installing $APP"
# --justlaunch installs, launches, and returns. Swap for --debug to attach
# lldb / stream device logs instead.
ios-deploy --bundle "$APP" --no-wifi --justlaunch
echo "✓ Done."
