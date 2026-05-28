const COMMANDS: &[&str] = &["open_single_file_window"];

fn main() {
    tauri_plugin::Builder::new(COMMANDS)
        .ios_path("ios")
        .build();
}
