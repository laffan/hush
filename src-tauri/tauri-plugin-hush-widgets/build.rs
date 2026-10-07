// No JS-invokable commands: the app's own `publish_widget_snapshot`
// command (src-tauri/src/widgets.rs) calls into the Swift half directly.
const COMMANDS: &[&str] = &[];

fn main() {
    tauri_plugin::Builder::new(COMMANDS)
        .ios_path("ios")
        .build();
}
