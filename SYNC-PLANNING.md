# Hush — Version Control & Sync Planning

> **Status**: In Progress  
> **Branch**: `claude/add-snapshot-version-control-0TO2i`  
> **Last Updated**: 2026-03-31  

## Instructions for Future Agents

- **Read this file first** before making any changes related to version control or sync.
- **Update this file** after completing each stage — mark it done, note any deviations from the plan, and add lessons learned.
- **Commit and push frequently** — after each major stage, and ideally after each sub-step.
- **700-line file limit** — no code file may exceed 700 lines. Split into modules as needed.
- **No frameworks** — the frontend is vanilla JS. Keep it that way.
- **Tauri IPC pattern** — backend commands in Rust, frontend calls via `invoke()`, events via `emit`/`listen`.

---

## Overview

Two major features:

1. **Version Control** — SQL-based (SQLite) snapshot system with time-decaying retention
2. **Sync Folders** — External folder syncing (desktop via filesystem, iPad via Dropbox API)

These systems are **separate but complementary**:
- The app manages documents internally (with IDs, version history)
- Sync ensures the external file matches the latest internal state
- If an external change is detected, the user is prompted to choose which version to keep

---

## Architecture Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Snapshot storage | SQLite via `rusqlite` | Efficient queries, time-based cleanup, single file |
| Snapshot content | Full content (not diffs) | Simpler restore/preview; decay keeps storage bounded |
| Cmd+S snapshots | Treated as normal versions | Decay applies equally; simplifies logic |
| Desktop file watching | `notify` crate | Real-time filesystem change detection |
| iPad sync | Dropbox HTTP API | Personal access token auth, 30-second polling |
| Synced file treatment | Full internal import | Files get IDs, version control, appear in file tree |

---

## Stage 1: SQLite Version Control Backend

**Goal**: Add SQLite database for document snapshots with time-decay cleanup.

### 1.1 Add Dependencies

**File**: `src-tauri/Cargo.toml`

```toml
rusqlite = { version = "0.31", features = ["bundled"] }
chrono = "0.4"
```

### 1.2 Create `snapshots.rs`

**File**: `src-tauri/src/snapshots.rs`

New module for all snapshot operations.

**Schema**:
```sql
CREATE TABLE IF NOT EXISTS snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    document_id TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at INTEGER NOT NULL,  -- Unix timestamp in seconds
    FOREIGN KEY (document_id) REFERENCES files(id)
);
CREATE INDEX IF NOT EXISTS idx_snapshots_doc_time 
    ON snapshots(document_id, created_at DESC);
```

**Struct**:
```rust
pub struct SnapshotManager {
    db_path: PathBuf,
}
```

**Methods**:
- `new(data_dir: &Path) -> Self` — opens/creates DB, runs migrations
- `create_snapshot(document_id: &str, content: &str) -> Result<i64>` — inserts snapshot, returns ID
- `get_snapshots(document_id: &str) -> Result<Vec<SnapshotEntry>>` — returns all snapshots for a doc, newest first
- `get_snapshot(id: i64) -> Result<SnapshotEntry>` — single snapshot by ID
- `restore_snapshot(id: i64) -> Result<SnapshotEntry>` — returns snapshot content for restoration
- `cleanup_snapshots(document_id: &str) -> Result<u64>` — applies decay rules, returns number deleted
- `cleanup_all() -> Result<u64>` — runs decay cleanup across all documents
- `delete_document_snapshots(document_id: &str) -> Result<()>` — removes all snapshots for a deleted doc

**SnapshotEntry struct**:
```rust
#[derive(Serialize, Deserialize, Clone)]
pub struct SnapshotEntry {
    pub id: i64,
    pub document_id: String,
    pub content: String,
    pub created_at: i64,  // Unix timestamp
}
```

**Decay Rules** (applied in `cleanup_snapshots`):
Working backwards from `now`:

| Window | Keep | Implementation |
|--------|------|----------------|
| 0–30 min | All | No deletion |
| 30 min–2 hr | 1/min | Group by minute, keep latest per group |
| 2–24 hr | 1/10 min | Group by 10-min window, keep latest |
| 1–7 days | 1/hr | Group by hour, keep latest |
| >7 days | 1/day | Group by day, keep latest |

Cleanup runs:
- After each snapshot creation
- On app startup

### 1.3 Integrate into AppState

**File**: `src-tauri/src/lib.rs`

- Add `SnapshotManager` to `AppState` struct
- Initialize in app setup alongside `FileManager`
- Add Tauri commands:
  - `create_snapshot(document_id, content) -> i64`
  - `get_snapshots(document_id) -> Vec<SnapshotEntry>`
  - `get_snapshot(id) -> SnapshotEntry`
  - `restore_snapshot(id) -> SnapshotEntry`
  - `cleanup_snapshots(document_id) -> u64`
  - `delete_document_snapshots(document_id)`

### 1.4 Hook into File Save

**File**: `src-tauri/src/lib.rs`

In the existing `save_file` command, after saving the file, also call `create_snapshot` and `cleanup_snapshots`.

**Deliverables**: Rust backend compiles, snapshots table created, CRUD operations work.

---

## Stage 2: Version Control Frontend

**Goal**: Keystroke-triggered snapshots, sidebar Versions panel, version preview, restore.

### 2.1 Keystroke Counter

**File**: `src/state.js`

- Add `keystrokeCount` counter (initialized to 0)
- Add `keystrokeSinceSnapshot` flag
- In the editor update listener, on each `docChanged`:
  - Increment `keystrokeCount`
  - Set `keystrokeSinceSnapshot = true`
  - If `keystrokeCount >= 30` and changes exist:
    - Call `invoke("create_snapshot", { documentId, content })`
    - Reset counter to 0

### 2.2 Cmd+S Snapshot

**File**: `src/editor.js`

- In the Cmd+S handler (or add one if not present):
  - Save file (existing behavior)
  - Also call `invoke("create_snapshot", { documentId, content })`

### 2.3 Versions Sidebar Button & Panel

**File**: `src/sidebar.js`

- Add new SVG icon: clock icon for "Versions"
- Add button in `sidebar-bottom` group, above "Save location" (which will be removed in Stage 3)
- When clicked, opens a Versions panel in `#panel-overlay`

### 2.4 Versions Panel UI

**New file**: `src/versions-panel.js`

The panel has two areas:
- **Left**: List of version timestamps (like the Files panel structure, but read-only)
  - Each entry shows:
    - Primary: human-readable timestamp (e.g., "Mar 31, 2:45 PM")
    - Secondary (small text): relative time (e.g., "2 hours ago")
  - Clicking a version loads its content into the right preview area
  - Active/selected version is highlighted
- **Right**: Read-only preview of the selected version's content (rendered in a simple pre/code block or read-only CodeMirror)

**Bottom bar**: Fixed bar centered at bottom of content pane with "Restore this version" button.
- Clicking restore:
  1. Replaces current document content with the snapshot content
  2. Saves the file
  3. Creates a new snapshot of the restored state
  4. Closes the versions panel
  5. Returns to normal editing

### 2.5 Versions Panel CSS

**New file**: `src/styles/versions-panel.css`

- Import in `src/styles/main.css`
- Style the two-column layout, timestamp list, preview area, restore button bar

### 2.6 Wire Up Delete

When a file is deleted, also call `invoke("delete_document_snapshots", { documentId })` to clean up.

**Deliverables**: Versions panel shows snapshots, preview works, restore works, keystroke auto-save works.

---

## Stage 3: Remove Save Location, Add Sync Settings Tab

**Goal**: Remove old autosave/Obsidian integration, add Sync tab to settings.

### 3.1 Remove Save Location

**Files to modify**:
- `src/sidebar.js` — Remove `autosave` button, `renderAutosavePanel`, `bindAutosavePanel`
- `src/styles/files-panel.css` — Remove `.autosave-panel` styles
- `src/state.js` — Remove `autosaveFolder` and `obsidianIntegration` from defaults
- `src-tauri/src/settings.rs` — Remove `autosave_folder` and `obsidian_integration` fields
- `src-tauri/src/lib.rs` — Remove `check_obsidian_vault` command, remove external save logic from `save_file`
- `src-tauri/src/files.rs` — Remove `save_to_external()` function and `.hush/` mapping logic

### 3.2 Add Sync Tab to Settings

**File**: `src/settings-window.js`

Add a new "Sync" tab after the existing tabs. Contents:

- **Sync Folders** heading
- List of currently synced folders (path + remove button)
- "Add Folder" button
- Platform-specific behavior (see Stage 4 for desktop, Stage 5 for iPad)

**File**: `src-tauri/src/settings.rs`

Add to `AppSettings`:
```rust
pub sync_folders: Vec<SyncFolder>,

#[derive(Serialize, Deserialize, Clone)]
pub struct SyncFolder {
    pub id: String,           // UUID
    pub path: String,         // filesystem path (desktop) or Dropbox path (iPad)
    pub sync_type: String,    // "local" or "dropbox"
    pub name: String,         // display name (folder basename)
}
```

Also add for iPad:
```rust
pub dropbox_token: Option<String>,
```

### 3.3 Synced Folder Icon

**File**: `src/sidebar_icons/` — Add new SVG icon: circle with a horizontal line through the middle (distinguishing synced folders from regular folders in the file tree).

**File**: `src/files-panel.js` — When rendering tree nodes that correspond to synced folders, use the synced folder icon instead of the regular circle.

**Deliverables**: Save Location removed, Sync tab visible in settings, sync folder data model in place.

---

## Stage 4: Desktop Folder Sync

**Goal**: Full filesystem sync for desktop — add folders, watch for changes, import files.

### 4.1 Add `notify` Dependency

**File**: `src-tauri/Cargo.toml`
```toml
notify = { version = "6", features = ["macos_fsevent"] }
```

### 4.2 Create `sync.rs`

**File**: `src-tauri/src/sync.rs`

New module for sync operations.

**Structs**:
```rust
pub struct SyncManager {
    watchers: HashMap<String, RecommendedWatcher>,  // folder_id -> watcher
    data_dir: PathBuf,
}
```

**Methods**:
- `new(data_dir: &Path) -> Self`
- `start_watching(folder: &SyncFolder) -> Result<()>` — starts a filesystem watcher
- `stop_watching(folder_id: &str)` — stops watcher
- `initial_import(folder_path: &str) -> Result<Vec<ImportEntry>>` — scans folder, returns list of .md files with paths
- `sync_file_to_external(file_id: &str, content: &str, external_path: &str) -> Result<()>` — writes content to external .md file
- `read_external_file(path: &str) -> Result<String>` — reads external file content
- `detect_external_changes(folder: &SyncFolder, known_files: &[SyncedFile]) -> Result<Vec<ChangeEvent>>` — compares external state to internal

**SyncedFile mapping** (stored in SQLite alongside snapshots, or separate table):
```sql
CREATE TABLE IF NOT EXISTS synced_files (
    id TEXT PRIMARY KEY,           -- internal file ID
    sync_folder_id TEXT NOT NULL,  -- which sync folder
    external_path TEXT NOT NULL,   -- relative path within sync folder
    last_synced_at INTEGER,        -- timestamp of last sync
    external_hash TEXT,            -- hash of last known external content
    FOREIGN KEY (sync_folder_id) REFERENCES sync_folders(id)
);
```

### 4.3 Add Folder Flow (Desktop)

1. User clicks "Add Folder" in Sync settings
2. Native file dialog opens (`tauri-plugin-dialog`)
3. User selects a folder
4. App scans for .md files (recursively, including nested folders)
5. If >5 files found, show confirmation dialog listing file count and structure summary
6. On confirm:
   - Create `SyncFolder` entry in settings
   - Import all .md files into internal system (create `FileEntry` for each)
   - Mirror folder structure in file tree (create folder `TreeNode` entries)
   - Mark imported tree nodes with sync folder reference
   - Start filesystem watcher
   - Emit event to refresh file tree in UI

### 4.4 Real-Time Sync (Desktop)

**Outbound** (internal → external):
- On every `save_file`, if the file belongs to a synced folder, write content to external path

**Inbound** (external → internal):
- `notify` watcher detects changes
- Emit Tauri event `sync-external-change` with file info
- Frontend handles conflict resolution (see Stage 6)

### 4.5 File Tree Integration

**File**: `src/files-panel.js`

- Synced folders appear in the file tree with the synced-folder icon
- Files within synced folders behave like normal files (open, edit, rename)
- Renaming a synced file also renames the external .md file
- Deleting a synced file also deletes the external .md file (with confirmation)
- New files created inside a synced folder are also created externally

**Deliverables**: Desktop sync works end-to-end — add folder, import files, real-time bidirectional sync.

---

## Stage 5: iPad Dropbox Sync

**Goal**: Dropbox-based sync for iPad/iOS with personal access token auth.

### 5.1 Dropbox API Module

**File**: `src/dropbox.js` (frontend module — Dropbox API calls go direct from JS since we have the token)

Or alternatively, implement in Rust. Given Tauri iOS sandboxing, JS fetch to Dropbox API is simpler.

**Methods**:
- `setToken(token)` — store token
- `testConnection() -> bool` — test token with `/2/users/get_current_account`
- `listFolder(path) -> [entries]` — `/2/files/list_folder`
- `downloadFile(path) -> string` — `/2/files/download`
- `uploadFile(path, content)` — `/2/files/upload` (mode: overwrite)
- `getMetadata(path) -> metadata` — `/2/files/get_metadata`
- `createFolder(path)` — `/2/files/create_folder_v2`

### 5.2 Sync Settings — iPad UI

**File**: `src/settings-window.js`

On iPad, the Sync tab has two stages:

**Stage A: Token Setup**
- Text input for Dropbox Personal Access Token
- "Test Connection" button
- Status indicator (connected/failed)
- Token saved in settings (`dropbox_token`)

**Stage B: Folder Management** (only visible once token is validated)
- Same list UI as desktop
- "Add Folder" button opens a **Dropbox folder browser modal**:
  - Shows Dropbox folder tree
  - Navigate into folders
  - "Select This Folder" button at bottom
  - On select: imports .md files, mirrors structure (same as desktop Stage 4.3)

### 5.3 Polling Sync (iPad)

- Every 30 seconds, for each synced Dropbox folder:
  - Call `listFolder` to get current state
  - Compare modification times / content hashes with internal state
  - If external changes detected, trigger conflict resolution (Stage 6)
- On internal file save, upload to Dropbox immediately

### 5.4 Platform Detection

**File**: `src/settings-window.js`

Use existing `isIOS()` helper to conditionally render:
- Desktop: native file dialog flow
- iPad: Dropbox token + browser flow

**Deliverables**: iPad users can authenticate with Dropbox, browse folders, sync files with 30-second polling.

---

## Stage 6: Seamless Auto-Sync ("Most Recent Wins")

**Goal**: Silently sync changes using timestamp comparison — no user intervention needed.

### 6.1 Timestamp Infrastructure

- `SyncedFileInfo` tracks `last_synced_at` (Unix timestamp of last successful sync)
- `ExternalChange` includes `external_modified` (filesystem mtime or Dropbox `server_modified`) and `internal_modified` (from `FileEntry.modified`)
- Rust backend fills both timestamps when checking for changes

### 6.2 Auto-Resolution Logic

**File**: `src/sync-polling.js`

Every 30 seconds, for each synced file with detected changes:
- **Local folders**: Compare `external_modified` vs `internal_modified` — newer wins
- **Dropbox folders**: Fetch metadata for `server_modified`, compare with `last_synced_at` and `internal_modified`
- If external is newer → silently accept (pull content, update editor if file is open)
- If internal is newer → silently push (write to external/upload to Dropbox)
- Update hash and timestamp after each sync

### 6.3 Subtle Sync Indicator

**File**: `src/styles/sync-conflict.css` (repurposed)

Non-intrusive indicator in bottom-right corner:
- "Synced ↓" for pulled changes, "Synced ↑" for pushed changes
- Fades in/out over 3 seconds, no user action needed

### 6.4 Safety Net

Users can always revert via the Versions panel (Stage 2) if auto-sync overwrites something unintended.

**Deliverables**: Seamless multi-device sync — changes appear automatically when switching devices.

---

## Implementation Order & Commit Strategy

```
Stage 1  →  commit + push  (SQLite backend)
Stage 2  →  commit + push  (Versions UI)
Stage 3  →  commit + push  (Remove save location + Sync tab shell)
Stage 4  →  commit + push  (Desktop sync)
Stage 5  →  commit + push  (iPad Dropbox sync)
Stage 6  →  commit + push  (Conflict resolution)
```

Each stage should be a working, non-breaking state. Commit after each sub-step if the change is substantial.

---

## File Map

New files to create:
- `src-tauri/src/snapshots.rs` — SQLite snapshot manager
- `src-tauri/src/sync.rs` — Filesystem sync manager
- `src/versions-panel.js` — Versions sidebar panel
- `src/styles/versions-panel.css` — Versions panel styles
- `src/dropbox.js` — Dropbox API client (iPad)
- `src/sync-conflict.js` — Conflict resolution modal
- `src/styles/sync-conflict.css` — Conflict modal styles
- `src/sidebar_icons/versions.svg` — Clock icon
- `src/sidebar_icons/synced-folder.svg` — Circle with line icon

Files to modify:
- `src-tauri/Cargo.toml` — Add `rusqlite`, `chrono`, `notify`
- `src-tauri/src/lib.rs` — Add snapshot commands, sync integration, remove obsidian
- `src-tauri/src/settings.rs` — Add `SyncFolder`, `dropbox_token`, remove `autosave_folder`
- `src-tauri/src/files.rs` — Remove `save_to_external`, add sync-aware save
- `src/state.js` — Keystroke counter, snapshot triggers, remove autosave folder
- `src/editor.js` — Cmd+S snapshot trigger
- `src/sidebar.js` — Add Versions button, remove Save Location button
- `src/files-panel.js` — Synced folder icon, sync-aware operations
- `src/settings-window.js` — Add Sync tab
- `src/styles/main.css` — Import new CSS files
- `src/styles/files-panel.css` — Remove autosave panel styles

---

## Progress Log

| Stage | Status | Date | Notes |
|-------|--------|------|-------|
| Planning | ✅ Complete | 2026-03-31 | Initial plan created |
| Stage 1 | ✅ Complete | 2026-03-31 | SQLite snapshots backend |
| Stage 2 | ✅ Complete | 2026-03-31 | Versions UI |
| Stage 3 | ✅ Complete | 2026-03-31 | Save location removed, Sync tab added |
| Stage 4 | ✅ Complete | 2026-03-31 | Desktop sync: add folders, import files, rename/delete propagation, create folder/project/file propagation, project JSON ordering, inbound change detection with 30s polling + conflict banners |
| Stage 5 | ✅ Complete | 2026-03-31 | Dropbox API client, folder browser modal, import flow, bidirectional sync (upload on save, 30s polling for changes), rename/delete/create propagation via Dropbox API |
| Stage 6 | ✅ Complete | 2026-03-31 | Auto-sync with "most recent wins" — no conflict banners, timestamps compared silently, subtle indicator shows sync direction. Users can revert via version history. |
