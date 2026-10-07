#!/usr/bin/env bash
#
# Build Hush for macOS with its home screen widgets.
#
# The ordinary `npm run tauri build` stays widget-free: widgets need an
# App Group signed into both the app and the extension, and macOS only
# honours one prefixed with your team ID, so they can't be on for every
# build. This script is the opt-in path (see widgets/README-WIDGETS.md):
#
#   HUSH_TEAM_ID=ABCDE12345 \
#   HUSH_SIGN_IDENTITY="Developer ID Application: Your Name (ABCDE12345)" \
#   npm run build:macos:widgets
#
# 1. Builds the widget extension (widgets/macos/project.yml) with
#    XcodeGen + xcodebuild, signed with its sandbox + App Group
#    entitlements.
# 2. Writes the app's own entitlements (the same App Group) and a Tauri
#    config overlay that signs the app with them and copies the extension
#    into Contents/PlugIns.
# 3. Runs `tauri build` with that overlay and the `macos-widgets` cargo
#    feature, which compiles in the Swift bridge that hands the widgets
#    their data (src-tauri/widget-bridge-macos).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

: "${HUSH_TEAM_ID:?Set HUSH_TEAM_ID to your Apple Developer team ID}"
: "${HUSH_SIGN_IDENTITY:?Set HUSH_SIGN_IDENTITY to the codesigning identity to sign with}"
command -v xcodegen >/dev/null 2>&1 || { echo "✗ xcodegen not found (brew install xcodegen)." >&2; exit 1; }

export HUSH_TEAM_ID HUSH_SIGN_IDENTITY
export HUSH_BUNDLE_ID="$(node -p "require('./src-tauri/tauri.conf.json').identifier")"
export HUSH_VERSION="$(node -p "require('./src-tauri/tauri.conf.json').version")"
export HUSH_MACOS_APP_GROUP="${HUSH_TEAM_ID}.${HUSH_BUNDLE_ID}"

BUILD="$ROOT/widgets/macos/build"
mkdir -p "$BUILD"

echo "▸ Generating and building the widget extension…"
xcodegen generate --spec widgets/macos/project.yml --project "$BUILD"
xcodebuild \
  -project "$BUILD/HushWidgetsMac.xcodeproj" \
  -target HushWidgets \
  -configuration Release \
  SYMROOT="$BUILD/products" \
  build
APPEX="$BUILD/products/Release/HushWidgets.appex"
[[ -d "$APPEX" ]] || { echo "✗ $APPEX wasn't produced." >&2; exit 1; }

echo "▸ Writing the app's entitlements and the Tauri config overlay…"
cat > "$BUILD/Hush.entitlements" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>com.apple.security.application-groups</key>
	<array>
		<string>${HUSH_MACOS_APP_GROUP}</string>
	</array>
</dict>
</plist>
PLIST
cat > "$BUILD/tauri.widgets.conf.json" <<JSON
{
  "bundle": {
    "macOS": {
      "signingIdentity": "${HUSH_SIGN_IDENTITY}",
      "entitlements": "${BUILD}/Hush.entitlements",
      "files": { "PlugIns/HushWidgets.appex": "${APPEX}" }
    }
  }
}
JSON

echo "▸ Building the app (macos-widgets feature)…"
npm run tauri -- build --features macos-widgets --config "$BUILD/tauri.widgets.conf.json"

APP="$(find src-tauri/target/release/bundle/macos -maxdepth 1 -name '*.app' | head -n1)"
if [[ -n "$APP" && -d "$APP/Contents/PlugIns/HushWidgets.appex" ]]; then
  echo "▸ Checking signatures…"
  codesign --verify --deep --strict "$APP" && echo "  app + extension verify"
  codesign -d --entitlements - "$APP/Contents/PlugIns/HushWidgets.appex" 2>/dev/null | grep -q application-groups \
    && echo "  extension keeps its App Group entitlement" \
    || echo "  ✗ the extension lost its entitlements — re-sign it before the app (see widgets/README-WIDGETS.md)" >&2
  echo "✓ $APP"
else
  echo "✗ The bundle has no PlugIns/HushWidgets.appex — see widgets/README-WIDGETS.md." >&2
  exit 1
fi
