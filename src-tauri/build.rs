/// Stamp the native binary with when and from where it was built, so the
/// Debug tab can report it. `option_env!` on the reading side means a
/// build without git (a source tarball, a sandboxed CI step) still
/// compiles — the fields just come back empty.
fn stamp_build_info() {
    let git = |args: &[&str]| -> String {
        std::process::Command::new("git")
            .args(args)
            .output()
            .ok()
            .filter(|o| o.status.success())
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
            .unwrap_or_default()
    };
    // SOURCE_DATE_EPOCH keeps reproducible builds reproducible; the
    // wall clock is only the fallback.
    let built_at = std::env::var("SOURCE_DATE_EPOCH")
        .ok()
        .and_then(|s| s.parse::<i64>().ok())
        .map(|secs| {
            chrono::DateTime::from_timestamp(secs, 0)
                .map(|d| d.to_rfc3339())
                .unwrap_or_default()
        })
        .unwrap_or_else(|| chrono::Utc::now().to_rfc3339());

    let branch = std::env::var("HUSH_GIT_BRANCH")
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| git(&["rev-parse", "--abbrev-ref", "HEAD"]));
    let commit = git(&["rev-parse", "--short", "HEAD"]);
    let dirty = !git(&["status", "--porcelain"]).is_empty();

    println!("cargo:rustc-env=HUSH_BUILD_TIME={}", built_at);
    println!("cargo:rustc-env=HUSH_GIT_BRANCH={}", branch);
    println!(
        "cargo:rustc-env=HUSH_GIT_COMMIT={}{}",
        commit,
        if dirty { "-dirty" } else { "" }
    );
    // Re-stamp whenever HEAD moves rather than on every compile.
    println!("cargo:rerun-if-changed=../.git/HEAD");
    println!("cargo:rerun-if-env-changed=HUSH_GIT_BRANCH");
    println!("cargo:rerun-if-env-changed=SOURCE_DATE_EPOCH");
}

fn main() {
    stamp_build_info();

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
