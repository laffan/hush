const COMMANDS: &[&str] = &["set_chrome_hidden"];

fn main() {
    tauri_plugin::Builder::new(COMMANDS)
        .ios_path("ios")
        .build();
}
