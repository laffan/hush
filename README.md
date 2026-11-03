# Hush

A distraction-free writing app for macOS and iPad. It is a Markdown editor
that lives in the menu bar, with notebooks (canvas-based notes), Zotero and
PDF support, and sync through any folder provider you already use (iCloud
Drive, Dropbox, and so on). Most actions go through the command palette
(`⌘P`).

## Installation

Download the installer for your system from the
[Releases](../../releases) page: `.dmg` (macOS).

The builds are not code-signed. On macOS, if the app is blocked on first
launch, move it to Applications and run:

```sh
xattr -cr "/Applications/Hush.app"
```

### Build from source

Requires [Node.js](https://nodejs.org/), [Rust](https://rustup.rs/) and the
[Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) for your OS.

```sh
npm install
npm run tauri build    # installers end up in src-tauri/target/release/bundle/
npm run tauri dev      # run in development
```

## More detail

[README_DETAIL.md](README_DETAIL.md) covers every feature. See also the `README-*.md` files for notebooks, drawing, sync and technical notes.
