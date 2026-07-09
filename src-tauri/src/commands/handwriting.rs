/// Handwriting recognition backend.
///
/// Takes a rasterized ink image (PNG, base64) from the frontend's
/// recognition engine (`src/recognition/handwriting.ts`) and runs it
/// through Apple's on-device Vision framework — `VNRecognizeTextRequest`
/// at the "accurate" recognition level, which handles handwriting.
/// Fully on-device: no network, nothing leaves the machine.
///
/// Non-Apple targets (the Linux dev build) return a descriptive error;
/// the frontend hides the affordance there anyway.
use base64::Engine as _;

#[tauri::command]
pub async fn recognize_handwriting(png_base64: String) -> Result<String, String> {
    // Accurate-level Vision recognition can take a second or two on a
    // large raster — keep it off the main thread.
    tauri::async_runtime::spawn_blocking(move || {
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(png_base64.as_bytes())
            .map_err(|e| format!("Invalid image payload: {e}"))?;
        if bytes.is_empty() {
            return Err("Empty image payload".into());
        }
        recognize(&bytes)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(any(target_os = "macos", target_os = "ios"))]
fn recognize(png: &[u8]) -> Result<String, String> {
    vision::recognize_text(png)
}

#[cfg(not(any(target_os = "macos", target_os = "ios")))]
fn recognize(_png: &[u8]) -> Result<String, String> {
    Err("Handwriting recognition is only available on macOS and iOS".into())
}

#[cfg(any(target_os = "macos", target_os = "ios"))]
mod vision {
    use crate::commands::apple_objc::{describe_nserror, describe_objc_exception, nsstring_to_string};
    use objc2::rc::autoreleasepool;
    use objc2::runtime::{AnyObject, Bool};
    use objc2::{class, msg_send, sel};
    use std::ffi::c_void;
    use std::panic::AssertUnwindSafe;
    use std::ptr;

    // Pull in the Vision framework at link time; `class!` resolves the
    // VN* classes from it at runtime.
    #[link(name = "Vision", kind = "framework")]
    extern "C" {}

    pub fn recognize_text(png: &[u8]) -> Result<String, String> {
        // Convert any NSException from the dynamic calls into a command
        // error rather than aborting the app.
        match objc2::exception::catch(AssertUnwindSafe(|| recognize_text_inner(png))) {
            Ok(result) => result,
            Err(ex) => Err(describe_objc_exception(ex, "Vision recognition")),
        }
    }

    fn recognize_text_inner(png: &[u8]) -> Result<String, String> {
        autoreleasepool(|_| unsafe {
            let data: *mut AnyObject = msg_send![
                class!(NSData),
                dataWithBytes: png.as_ptr() as *const c_void,
                length: png.len()
            ];
            if data.is_null() {
                return Err("Failed to wrap image bytes".into());
            }
            let options: *mut AnyObject = msg_send![class!(NSDictionary), dictionary];
            let handler: *mut AnyObject = msg_send![class!(VNImageRequestHandler), alloc];
            let handler: *mut AnyObject = msg_send![handler, initWithData: data, options: options];
            if handler.is_null() {
                return Err("Failed to create Vision request handler".into());
            }

            let request: *mut AnyObject = msg_send![class!(VNRecognizeTextRequest), alloc];
            let request: *mut AnyObject = msg_send![request, init];
            if request.is_null() {
                let _: () = msg_send![handler, release];
                return Err("Failed to create Vision text request".into());
            }
            // VNRequestTextRecognitionLevelAccurate = 0 — the level that
            // recognizes handwriting (Fast = 1 is print-only).
            let _: () = msg_send![request, setRecognitionLevel: 0isize];
            let _: () = msg_send![request, setUsesLanguageCorrection: Bool::YES];
            // Pin the newest recognizer revision the OS ships. Left
            // unset, the revision tracks the SDK the binary was linked
            // against, which can select an older (worse) handwriting
            // model than the one actually installed.
            let revisions: *mut AnyObject =
                msg_send![class!(VNRecognizeTextRequest), supportedRevisions];
            if !revisions.is_null() {
                let last: usize = msg_send![revisions, lastIndex];
                // NSNotFound (empty index set) is NSIntegerMax.
                if last != isize::MAX as usize {
                    let _: () = msg_send![request, setRevision: last];
                }
            }
            // Language auto-detection (macOS 13+ / iOS 16+) helps with
            // mixed or non-English handwriting; probe the selector so
            // older systems don't throw.
            let has_auto_lang: Bool = msg_send![
                request,
                respondsToSelector: sel!(setAutomaticallyDetectsLanguage:)
            ];
            if has_auto_lang.as_bool() {
                let _: () = msg_send![request, setAutomaticallyDetectsLanguage: Bool::YES];
            }

            let requests: *mut AnyObject = msg_send![class!(NSArray), arrayWithObject: request];
            let mut error: *mut AnyObject = ptr::null_mut();
            let error_out: *mut *mut AnyObject = &mut error;
            let ok: Bool = msg_send![handler, performRequests: requests, error: error_out];

            let result = if ok.as_bool() {
                Ok(collect_lines(request))
            } else {
                Err(describe_nserror(error, "Vision recognition failed"))
            };
            let _: () = msg_send![request, release];
            let _: () = msg_send![handler, release];
            result
        })
    }

    /// Vision returns one `VNRecognizedTextObservation` per detected
    /// line, top-to-bottom. Join each observation's best candidate.
    unsafe fn collect_lines(request: *mut AnyObject) -> String {
        let results: *mut AnyObject = msg_send![request, results];
        if results.is_null() {
            return String::new();
        }
        let count: usize = msg_send![results, count];
        let mut lines: Vec<String> = Vec::with_capacity(count);
        for i in 0..count {
            let obs: *mut AnyObject = msg_send![results, objectAtIndex: i];
            if obs.is_null() {
                continue;
            }
            let candidates: *mut AnyObject = msg_send![obs, topCandidates: 1usize];
            if candidates.is_null() {
                continue;
            }
            let ccount: usize = msg_send![candidates, count];
            if ccount == 0 {
                continue;
            }
            let best: *mut AnyObject = msg_send![candidates, objectAtIndex: 0usize];
            let text: *mut AnyObject = msg_send![best, string];
            if let Some(line) = nsstring_to_string(text) {
                if !line.is_empty() {
                    lines.push(line);
                }
            }
        }
        lines.join("\n")
    }

}
