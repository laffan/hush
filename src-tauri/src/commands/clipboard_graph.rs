//! Flowcharts across the pasteboard between a notebook and Woods Whisper's
//! graph documents (`src/notebook/graph-pasteboard.ts` has the whole story).
//!
//! Two things the webview can't do on its own:
//!
//!   - **Read Woods Whisper's cards.** They travel under
//!     `com.woodswhisper.graph-nodes`, and WebKit only hands a page plain
//!     text, HTML, images and URIs — never another app's own type.
//!   - **Write Hush's own type.** A notebook copy goes on the pasteboard
//!     as text *and* as `com.hushwriter.canvas-clipboard` (the same JSON),
//!     so Woods Whisper can ask whether a flowchart is there without
//!     reading it — which on iOS is what spares it the "Allow Paste"
//!     prompt for every copy that isn't one.
//!
//! Elsewhere the read finds nothing and the write is refused, and the
//! notebook falls back to text, as it always has.

#[cfg(any(target_os = "macos", target_os = "ios"))]
use objc2::msg_send;
#[cfg(any(target_os = "macos", target_os = "ios"))]
use objc2::runtime::AnyObject;

#[cfg(any(target_os = "macos", target_os = "ios"))]
use super::apple_objc::nsstring_from_str;
#[cfg(any(target_os = "macos", target_os = "ios"))]
use super::clipboard_pdf::nsdata_bytes;

#[cfg_attr(not(any(target_os = "macos", target_os = "ios")), allow(dead_code))]
const WOODS_WHISPER_UTI: &str = "com.woodswhisper.graph-nodes";
#[cfg_attr(not(any(target_os = "macos", target_os = "ios")), allow(dead_code))]
const HUSH_CANVAS_UTI: &str = "com.hushwriter.canvas-clipboard";
#[cfg_attr(not(any(target_os = "macos", target_os = "ios")), allow(dead_code))]
const PLAIN_TEXT_UTI: &str = "public.utf8-plain-text";

#[cfg_attr(not(any(target_os = "macos", target_os = "ios")), allow(dead_code))]
fn utf8(bytes: Option<Vec<u8>>) -> String {
    bytes.and_then(|b| String::from_utf8(b).ok()).unwrap_or_default()
}

/// An autoreleased NSData holding `bytes`. `dataWithBytes:` takes a
/// `const void *`, declared as exactly that for objc2's signature check
/// (see `nsdata_bytes`).
#[cfg(any(target_os = "macos", target_os = "ios"))]
unsafe fn nsdata(bytes: &[u8]) -> *mut AnyObject {
    let cls = objc2::class!(NSData);
    msg_send![cls, dataWithBytes: bytes.as_ptr() as *const std::ffi::c_void, length: bytes.len()]
}

/// Release the owned NSStrings `nsstring_from_str` built.
#[cfg(any(target_os = "macos", target_os = "ios"))]
unsafe fn release_all(objects: &[*mut AnyObject]) {
    for &o in objects {
        let _: () = msg_send![o, release];
    }
}

#[cfg(target_os = "macos")]
fn read_graph() -> Result<String, String> {
    unsafe {
        let pb: *mut AnyObject = msg_send![objc2::class!(NSPasteboard), generalPasteboard];
        if pb.is_null() {
            return Ok(String::new());
        }
        let ty = nsstring_from_str(WOODS_WHISPER_UTI)?;
        let data: *mut AnyObject = msg_send![pb, dataForType: ty];
        release_all(&[ty]);
        Ok(utf8(nsdata_bytes(data)))
    }
}

#[cfg(target_os = "ios")]
fn read_graph() -> Result<String, String> {
    unsafe {
        let pb: *mut AnyObject = msg_send![objc2::class!(UIPasteboard), generalPasteboard];
        if pb.is_null() {
            return Ok(String::new());
        }
        let ty = nsstring_from_str(WOODS_WHISPER_UTI)?;
        // Ask first, read second, as `clipboard_pdf` does: the type check
        // is answered without the "Allow Paste" prompt, and this runs on
        // every canvas paste — only one that really is Woods Whisper's
        // should be able to raise it.
        let types: *mut AnyObject = msg_send![objc2::class!(NSArray), arrayWithObject: ty];
        let has: bool = !types.is_null() && msg_send![pb, containsPasteboardTypes: types];
        let data: *mut AnyObject = if has {
            msg_send![pb, dataForPasteboardType: ty]
        } else {
            std::ptr::null_mut()
        };
        release_all(&[ty]);
        Ok(utf8(nsdata_bytes(data)))
    }
}

#[cfg(not(any(target_os = "macos", target_os = "ios")))]
fn read_graph() -> Result<String, String> {
    Ok(String::new())
}

#[cfg(target_os = "macos")]
fn write_canvas(json: &str) -> Result<(), String> {
    unsafe {
        let pb: *mut AnyObject = msg_send![objc2::class!(NSPasteboard), generalPasteboard];
        if pb.is_null() {
            return Err("No pasteboard".into());
        }
        let text = nsstring_from_str(json)?;
        let text_type = nsstring_from_str(PLAIN_TEXT_UTI)?;
        let hush_type = nsstring_from_str(HUSH_CANVAS_UTI)?;
        let _: isize = msg_send![pb, clearContents];
        let wrote_text: bool = msg_send![pb, setString: text, forType: text_type];
        let wrote_hush: bool = msg_send![pb, setData: nsdata(json.as_bytes()), forType: hush_type];
        release_all(&[text, text_type, hush_type]);
        if wrote_text && wrote_hush {
            Ok(())
        } else {
            Err("The pasteboard refused the copy".into())
        }
    }
}

#[cfg(target_os = "ios")]
fn write_canvas(json: &str) -> Result<(), String> {
    unsafe {
        let pb: *mut AnyObject = msg_send![objc2::class!(UIPasteboard), generalPasteboard];
        if pb.is_null() {
            return Err("No pasteboard".into());
        }
        let text = nsstring_from_str(json)?;
        let text_type = nsstring_from_str(PLAIN_TEXT_UTI)?;
        let hush_type = nsstring_from_str(HUSH_CANVAS_UTI)?;
        // One item carrying both, so a reader asking for either type finds
        // it on the first item — which is where UIPasteboard looks.
        let keys = [text_type, hush_type];
        let values = [text, nsdata(json.as_bytes())];
        let item: *mut AnyObject = msg_send![
            objc2::class!(NSDictionary),
            dictionaryWithObjects: values.as_ptr(),
            forKeys: keys.as_ptr(),
            count: 2usize
        ];
        let items: *mut AnyObject = msg_send![objc2::class!(NSArray), arrayWithObject: item];
        let _: () = msg_send![pb, setItems: items];
        release_all(&[text, text_type, hush_type]);
        Ok(())
    }
}

#[cfg(not(any(target_os = "macos", target_os = "ios")))]
fn write_canvas(_json: &str) -> Result<(), String> {
    Err("Writing the canvas pasteboard type isn't supported on this platform".into())
}

/// The JSON of Woods Whisper's copied cards, or "" when there are none.
#[tauri::command]
pub async fn read_woods_whisper_graph(app: tauri::AppHandle) -> Result<String, String> {
    on_main(app, "read_woods_whisper_graph", read_graph)
}

/// A notebook copy, as text and under Hush's own type.
#[tauri::command]
pub async fn write_canvas_clipboard(app: tauri::AppHandle, json: String) -> Result<(), String> {
    on_main(app, "write_canvas_clipboard", move || write_canvas(&json))
}

/// Run a pasteboard call on the main thread, where UIPasteboard expects
/// it — catching an Objective-C exception and a Rust panic alike, since
/// neither may leave a main-thread callback (see `clipboard_pdf`).
#[cfg(any(target_os = "macos", target_os = "ios"))]
fn on_main<T, F>(app: tauri::AppHandle, what: &'static str, f: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    let (tx, rx) = std::sync::mpsc::channel();
    app.run_on_main_thread(move || {
        let run = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| unsafe {
            objc2::exception::catch(std::panic::AssertUnwindSafe(f))
        }));
        let r = match run {
            Ok(Ok(r)) => r,
            Ok(Err(e)) => Err(super::apple_objc::describe_objc_exception(e, what)),
            Err(_) => Err(format!("{what} failed")),
        };
        let _ = tx.send(r);
    })
    .map_err(|e| e.to_string())?;
    rx.recv().map_err(|e| e.to_string())?
}

#[cfg(not(any(target_os = "macos", target_os = "ios")))]
fn on_main<T, F>(app: tauri::AppHandle, what: &'static str, f: F) -> Result<T, String>
where
    F: FnOnce() -> Result<T, String>,
{
    let _ = (app, what);
    f()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_only_utf8() {
        assert_eq!(utf8(Some(b"{\"nodes\":[]}".to_vec())), "{\"nodes\":[]}");
        assert_eq!(utf8(Some(vec![0xff, 0xfe])), "");
        assert_eq!(utf8(None), "");
    }
}
