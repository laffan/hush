fn main() {
    // Fix: swift-rs hardcodes a clang version in the library search path
    // (e.g. clang/17/lib/darwin) which may not match the installed Xcode.
    // Dynamically resolve the correct path so the linker can find clang_rt.ios.
    if std::env::var("TARGET")
        .unwrap_or_default()
        .contains("apple-ios")
    {
        if let Ok(output) = std::process::Command::new("clang")
            .arg("--print-resource-dir")
            .output()
        {
            let resource_dir = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !resource_dir.is_empty() {
                println!("cargo:rustc-link-search=native={}/lib/darwin", resource_dir);
            }
        }
    }

    tauri_build::build()
}
