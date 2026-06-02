const COMMANDS: &[&str] = &[
    "pick_folder",
    "resolve_bookmark",
    "stop_access",
    "reveal_in_files",
    "list_dir",
    "read_file",
    "write_file",
    "read_file_bytes",
    "write_file_bytes",
];

fn main() {
    tauri_plugin::Builder::new(COMMANDS)
        .ios_path("ios")
        .build();
}
