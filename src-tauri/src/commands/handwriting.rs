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
pub fn recognize_handwriting(png_base64: String) -> Result<String, String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(png_base64.as_bytes())
        .map_err(|e| format!("Invalid image payload: {e}"))?;
    if bytes.is_empty() {
        return Err("Empty image payload".into());
    }
    recognize(&bytes)
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
    use objc2::rc::autoreleasepool;
    use objc2::runtime::{AnyObject, Bool};
    use objc2::{class, msg_send, sel};
    use std::ffi::{c_char, c_void, CStr};
    use std::ptr;

    // Pull in the Vision framework at link time; `class!` resolves the
    // VN* classes from it at runtime.
    #[link(name = "Vision", kind = "framework")]
    extern "C" {}

    pub fn recognize_text(png: &[u8]) -> Result<String, String> {
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
                Err(describe_nserror(error))
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

    unsafe fn nsstring_to_string(s: *mut AnyObject) -> Option<String> {
        if s.is_null() {
            return None;
        }
        let utf8: *const c_char = msg_send![s, UTF8String];
        if utf8.is_null() {
            return None;
        }
        Some(CStr::from_ptr(utf8).to_string_lossy().into_owned())
    }

    unsafe fn describe_nserror(err: *mut AnyObject) -> String {
        if err.is_null() {
            return "Vision recognition failed".into();
        }
        let desc: *mut AnyObject = msg_send![err, localizedDescription];
        nsstring_to_string(desc).unwrap_or_else(|| "Vision recognition failed".into())
    }
}
