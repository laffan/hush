//! A PDF off the system clipboard — the Zotero link menu's "Import PDF"
//! clipboard button.
//!
//! The webview's clipboard API can't do this: WebKit exposes plain text,
//! HTML, PNG and URIs, never `application/pdf`, and a file copied in the
//! Finder or the Files app arrives as a file URL the page may not read.
//! The pasteboard holds the PDF in one of two shapes, tried in order:
//!
//!   - **PDF data** (`com.adobe.pdf`) — what Preview, a browser's PDF
//!     view or the Files app's Copy put there;
//!   - **a file URL** (`public.file-url`) — a `.pdf` copied in the Finder
//!     (macOS only; iOS hands the Files app's copies over as data).
//!
//! Returns `None` when neither is there, so the caller can say "no PDF on
//! the clipboard" rather than report an error.

#[cfg(any(target_os = "macos", target_os = "ios"))]
use objc2::msg_send;
#[cfg(any(target_os = "macos", target_os = "ios"))]
use objc2::runtime::AnyObject;

#[cfg(any(target_os = "macos", target_os = "ios"))]
use super::apple_objc::nsstring_from_str;
#[cfg(target_os = "macos")]
use super::apple_objc::nsstring_to_string;

#[cfg_attr(not(any(target_os = "macos", target_os = "ios")), allow(dead_code))]
const PDF_UTI: &str = "com.adobe.pdf";

/// Copy an NSData's bytes out (null → None).
///
/// `-bytes` returns `const void *`, and it has to be declared as exactly
/// that: debug builds of objc2 check every message's Rust types against
/// the method's Objective-C signature and panic on a mismatch, and a
/// `*const u8` (`^C`) against `^v` is one. That panic fired on the main
/// thread, inside `run_on_main_thread`, where it can't unwind — the
/// clipboard button took the whole app down on iPad.
#[cfg(any(target_os = "macos", target_os = "ios"))]
pub(super) unsafe fn nsdata_bytes(data: *mut AnyObject) -> Option<Vec<u8>> {
    if data.is_null() {
        return None;
    }
    let len: usize = msg_send![data, length];
    if len == 0 {
        return None;
    }
    let ptr: *const std::ffi::c_void = msg_send![data, bytes];
    if ptr.is_null() {
        return None;
    }
    Some(std::slice::from_raw_parts(ptr as *const u8, len).to_vec())
}

#[cfg_attr(not(any(target_os = "macos", target_os = "ios")), allow(dead_code))]
fn looks_like_pdf(bytes: &[u8]) -> bool {
    let head = &bytes[..bytes.len().min(1024)];
    head.windows(5).any(|w| w == b"%PDF-")
}

/// `file:///Users/x/My%20Paper.pdf` → the path, percent-decoded.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn file_url_to_path(url: &str) -> Option<std::path::PathBuf> {
    let rest = url.strip_prefix("file://")?;
    // `file://localhost/…` is the long form of the same thing.
    let rest = rest.strip_prefix("localhost").unwrap_or(rest);
    let bytes = rest.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(b) = u8::from_str_radix(std::str::from_utf8(&bytes[i + 1..i + 3]).ok()?, 16) {
                out.push(b);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    Some(std::path::PathBuf::from(String::from_utf8(out).ok()?))
}

#[cfg(target_os = "macos")]
fn read_pasteboard_pdf() -> Result<Option<Vec<u8>>, String> {
    unsafe {
        let cls = objc2::class!(NSPasteboard);
        let pb: *mut AnyObject = msg_send![cls, generalPasteboard];
        if pb.is_null() {
            return Ok(None);
        }
        let pdf_type = nsstring_from_str(PDF_UTI)?;
        let data: *mut AnyObject = msg_send![pb, dataForType: pdf_type];
        let _: () = msg_send![pdf_type, release];
        if let Some(bytes) = nsdata_bytes(data) {
            if looks_like_pdf(&bytes) {
                return Ok(Some(bytes));
            }
        }
        let url_type = nsstring_from_str("public.file-url")?;
        let url: *mut AnyObject = msg_send![pb, stringForType: url_type];
        let _: () = msg_send![url_type, release];
        let Some(url) = nsstring_to_string(url) else { return Ok(None) };
        let Some(path) = file_url_to_path(url.trim()) else { return Ok(None) };
        let is_pdf = path
            .extension()
            .map(|e| e.eq_ignore_ascii_case("pdf"))
            .unwrap_or(false);
        if !is_pdf {
            return Ok(None);
        }
        let bytes = std::fs::read(&path).map_err(|e| format!("{}: {e}", path.display()))?;
        Ok(looks_like_pdf(&bytes).then_some(bytes))
    }
}

#[cfg(target_os = "ios")]
fn read_pasteboard_pdf() -> Result<Option<Vec<u8>>, String> {
    unsafe {
        let cls = objc2::class!(UIPasteboard);
        let pb: *mut AnyObject = msg_send![cls, generalPasteboard];
        if pb.is_null() {
            return Ok(None);
        }
        let pdf_type = nsstring_from_str(PDF_UTI)?;
        // Ask first, read second: `containsPasteboardTypes:` is one of the
        // checks iOS answers without the "Allow Paste" prompt, so an empty
        // or PDF-less clipboard says so quietly instead of asking the user
        // to allow a paste that then yields nothing.
        let array_cls = objc2::class!(NSArray);
        let types: *mut AnyObject = msg_send![array_cls, arrayWithObject: pdf_type];
        let has_pdf: bool = !types.is_null() && msg_send![pb, containsPasteboardTypes: types];
        let data: *mut AnyObject = if has_pdf {
            msg_send![pb, dataForPasteboardType: pdf_type]
        } else {
            std::ptr::null_mut()
        };
        let _: () = msg_send![pdf_type, release];
        Ok(nsdata_bytes(data).filter(|b| looks_like_pdf(b)))
    }
}

#[cfg(not(any(target_os = "macos", target_os = "ios")))]
fn read_pasteboard_pdf() -> Result<Option<Vec<u8>>, String> {
    Err("Reading a PDF from the clipboard isn't supported on this platform".into())
}

/// Raw bytes back over IPC (an `ArrayBuffer` on the JS side, empty when
/// there was no PDF) — a PDF as a JSON number array is several times its
/// size in text, built and parsed on the webview's thread.
#[tauri::command]
pub async fn read_clipboard_pdf(app: tauri::AppHandle) -> Result<tauri::ipc::Response, String> {
    let bytes = read_on_main(app)?;
    Ok(tauri::ipc::Response::new(bytes.unwrap_or_default()))
}

#[cfg(any(target_os = "macos", target_os = "ios"))]
fn read_on_main(app: tauri::AppHandle) -> Result<Option<Vec<u8>>, String> {
    // The pasteboard is read on the main thread — UIPasteboard expects it,
    // and copying a few MB out is far below a frame's worth of work.
    // Both kinds of failure are caught there: an Objective-C exception,
    // and a Rust panic, which must never leave a main-thread callback —
    // it can't unwind through the event loop and aborts the app.
    let (tx, rx) = std::sync::mpsc::channel();
    app.run_on_main_thread(move || {
        let read = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| unsafe {
            objc2::exception::catch(std::panic::AssertUnwindSafe(read_pasteboard_pdf))
        }));
        let r = match read {
            Ok(Ok(r)) => r,
            Ok(Err(e)) => Err(super::apple_objc::describe_objc_exception(e, "read_clipboard_pdf")),
            Err(_) => Err("Reading the clipboard failed".to_string()),
        };
        let _ = tx.send(r);
    })
    .map_err(|e| e.to_string())?;
    rx.recv().map_err(|e| e.to_string())?
}

#[cfg(not(any(target_os = "macos", target_os = "ios")))]
fn read_on_main(app: tauri::AppHandle) -> Result<Option<Vec<u8>>, String> {
    let _ = app;
    read_pasteboard_pdf()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_file_urls() {
        assert_eq!(
            file_url_to_path("file:///Users/x/My%20Paper.pdf").unwrap(),
            std::path::PathBuf::from("/Users/x/My Paper.pdf")
        );
        assert_eq!(
            file_url_to_path("file://localhost/tmp/a.pdf").unwrap(),
            std::path::PathBuf::from("/tmp/a.pdf")
        );
        assert!(file_url_to_path("https://example.com/a.pdf").is_none());
    }

    #[test]
    fn sniffs_pdf_header() {
        assert!(looks_like_pdf(b"%PDF-1.7\n..."));
        assert!(!looks_like_pdf(b"<html>"));
    }
}
