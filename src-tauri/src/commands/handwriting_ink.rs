/// Stroke-based handwriting recognition via Google's ML Kit Digital
/// Ink Recognition — the second recognition backend, next to the
/// Vision raster one in `handwriting.rs`, kept side by side so the
/// two can be compared.
///
/// ML Kit only ships for iOS (and Android): the pod is added to the
/// Tauri-generated Xcode project by `scripts/ios-add-mlkit-pod.mjs`,
/// and this module reaches its Objective-C classes **dynamically**
/// (`AnyClass::get`) rather than linking a framework — so the same
/// binary builds with or without the pod, and a build without it
/// returns a descriptive error instead of failing to link. macOS and
/// Linux always take the error path.
///
/// The recognizer wants timestamps per point; the frontend synthesizes
/// them (Hush doesn't record pen timing), which costs some accuracy
/// versus a true ink stream but keeps the stroke geometry exact.
use serde::Deserialize;

#[derive(Deserialize)]
pub struct InkPoint {
    pub x: f64,
    pub y: f64,
    /// Milliseconds; synthesized monotonically by the frontend.
    pub t: i64,
}

#[derive(Deserialize)]
pub struct InkStroke {
    pub points: Vec<InkPoint>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InkPayload {
    pub strokes: Vec<InkStroke>,
    pub language: Option<String>,
    pub writing_area_width: f64,
    pub writing_area_height: f64,
}

#[tauri::command]
pub async fn recognize_handwriting_ink(payload: InkPayload) -> Result<String, String> {
    if payload.strokes.is_empty() {
        return Err("No strokes to recognize".into());
    }
    // Model download polling + recognition can take a while — keep it
    // off the main thread.
    tauri::async_runtime::spawn_blocking(move || recognize(&payload))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(target_os = "ios")]
fn recognize(payload: &InkPayload) -> Result<String, String> {
    mlkit::recognize(payload)
}

#[cfg(not(target_os = "ios"))]
fn recognize(_payload: &InkPayload) -> Result<String, String> {
    Err("ML Kit ink recognition is only available on iOS / iPadOS (Google doesn't ship ML Kit for macOS)".into())
}

#[cfg(target_os = "ios")]
mod mlkit {
    use super::{InkPayload, InkStroke};
    use crate::commands::apple_objc::{
        describe_nserror, describe_objc_exception, nsstring_from_str, nsstring_to_string,
    };
    use block2::RcBlock;
    use objc2::rc::autoreleasepool;
    use objc2::runtime::{AnyClass, AnyObject, Bool};
    use objc2::{msg_send, sel};
    use std::panic::AssertUnwindSafe;
    use std::ptr;
    use std::sync::mpsc;
    use std::time::Duration;

    const NOT_LINKED: &str = "Google ML Kit isn't linked into this build — run `node scripts/ios-add-mlkit-pod.mjs` after `npm run ios:init`, then rebuild (see README-NOTEBOOK.md)";

    /// Dynamic class lookup — None when the pod isn't linked.
    fn cls(name: &str) -> Result<&'static AnyClass, String> {
        AnyClass::get(name).ok_or_else(|| format!("{NOT_LINKED} (class {name} missing)"))
    }

    pub fn recognize(payload: &InkPayload) -> Result<String, String> {
        // ML Kit's ObjC surface varies across releases; a selector we
        // guessed wrong raises an NSException, which would abort the
        // whole app — surface it as a command error instead.
        match objc2::exception::catch(AssertUnwindSafe(|| recognize_inner(payload))) {
            Ok(result) => result,
            Err(ex) => Err(describe_objc_exception(ex, "ML Kit ink recognition")),
        }
    }

    fn recognize_inner(payload: &InkPayload) -> Result<String, String> {
        autoreleasepool(|_| unsafe {
            let ink = build_ink(&payload.strokes)?;
            let tag = payload.language.as_deref().unwrap_or("en-US");
            let model = model_for_language(tag)?;
            ensure_model_downloaded(model)?;

            let options_cls = cls("MLKDigitalInkRecognizerOptions")?;
            let options: *mut AnyObject = msg_send![options_cls, alloc];
            let options: *mut AnyObject = msg_send![options, initWithModel: model];
            let recognizer_cls = cls("MLKDigitalInkRecognizer")?;
            let recognizer: *mut AnyObject =
                msg_send![recognizer_cls, digitalInkRecognizerWithOptions: options];
            if recognizer.is_null() {
                let _: () = msg_send![options, release];
                let _: () = msg_send![model, release];
                let _: () = msg_send![ink, release];
                return Err("Failed to create ML Kit recognizer".into());
            }

            // Writing-area context measurably improves accuracy — it
            // tells the model how big the canvas region is relative to
            // the ink.
            let wa_cls = cls("MLKWritingArea")?;
            let wa: *mut AnyObject = msg_send![wa_cls, alloc];
            let wa: *mut AnyObject = msg_send![
                wa,
                initWithWidth: payload.writing_area_width as f32,
                height: payload.writing_area_height as f32
            ];
            let ctx_cls = cls("MLKDigitalInkRecognitionContext")?;
            let pre = nsstring_from_str("")?;
            let context: *mut AnyObject = msg_send![ctx_cls, alloc];
            let context: *mut AnyObject =
                msg_send![context, initWithPreContext: pre, writingArea: wa];

            // The recognize API is completion-block only; bridge it to
            // a channel and block this (non-main) thread on the result.
            let (tx, rx) = mpsc::channel::<Result<String, String>>();
            let block = RcBlock::new(move |result: *mut AnyObject, error: *mut AnyObject| {
                let out = extract_top_candidate(result, error);
                let _ = tx.send(out);
            });
            // The context-taking variant postdates the plain one —
            // probe and fall back so older pods still work.
            let has_ctx_variant: Bool = msg_send![
                recognizer,
                respondsToSelector: sel!(recognizeInk:context:completion:)
            ];
            if has_ctx_variant.as_bool() {
                let _: () = msg_send![
                    recognizer,
                    recognizeInk: ink,
                    context: context,
                    completion: &*block
                ];
            } else {
                let _: () = msg_send![recognizer, recognizeInk: ink, completion: &*block];
            }

            let out = rx
                .recv_timeout(Duration::from_secs(30))
                .map_err(|_| "ML Kit recognition timed out".to_string())?;

            let _: () = msg_send![context, release];
            let _: () = msg_send![pre, release];
            let _: () = msg_send![wa, release];
            let _: () = msg_send![options, release];
            let _: () = msg_send![model, release];
            let _: () = msg_send![ink, release];
            out
        })
    }

    /// strokes → MLKInk (owned; caller releases).
    unsafe fn build_ink(strokes: &[InkStroke]) -> Result<*mut AnyObject, String> {
        let point_cls = cls("MLKStrokePoint")?;
        let stroke_cls = cls("MLKStroke")?;
        let ink_cls = cls("MLKInk")?;
        let array_cls = cls("NSMutableArray")?;

        // The timed initializer is the normal one; probe it anyway so a
        // pod release without it degrades to untimed points instead of
        // raising.
        let has_timed_init: Bool =
            msg_send![point_cls, instancesRespondToSelector: sel!(initWithX:y:t:)];

        let stroke_arr: *mut AnyObject = msg_send![array_cls, array];
        for s in strokes {
            let point_arr: *mut AnyObject = msg_send![array_cls, array];
            for p in &s.points {
                let sp: *mut AnyObject = msg_send![point_cls, alloc];
                let sp: *mut AnyObject = if has_timed_init.as_bool() {
                    msg_send![sp, initWithX: p.x as f32, y: p.y as f32, t: p.t as isize]
                } else {
                    msg_send![sp, initWithX: p.x as f32, y: p.y as f32]
                };
                if sp.is_null() {
                    continue;
                }
                let _: () = msg_send![point_arr, addObject: sp];
                let _: () = msg_send![sp, release];
            }
            let count: usize = msg_send![point_arr, count];
            if count == 0 {
                continue;
            }
            let st: *mut AnyObject = msg_send![stroke_cls, alloc];
            let st: *mut AnyObject = msg_send![st, initWithPoints: point_arr];
            if st.is_null() {
                continue;
            }
            let _: () = msg_send![stroke_arr, addObject: st];
            let _: () = msg_send![st, release];
        }
        let count: usize = msg_send![stroke_arr, count];
        if count == 0 {
            return Err("No usable strokes to recognize".into());
        }
        let ink: *mut AnyObject = msg_send![ink_cls, alloc];
        let ink: *mut AnyObject = msg_send![ink, initWithStrokes: stroke_arr];
        if ink.is_null() {
            return Err("Failed to build ML Kit ink".into());
        }
        Ok(ink)
    }

    /// language tag → MLKDigitalInkRecognitionModel (owned).
    unsafe fn model_for_language(tag: &str) -> Result<*mut AnyObject, String> {
        let ident_cls = cls("MLKDigitalInkRecognitionModelIdentifier")?;
        let tag_ns = nsstring_from_str(tag)?;
        // The factory selector changed across ML Kit releases — probe
        // the newer throwing variant first.
        let has_new: Bool = msg_send![
            ident_cls,
            respondsToSelector: sel!(modelIdentifierFromLanguageTag:error:)
        ];
        let identifier: *mut AnyObject = if has_new.as_bool() {
            let mut err: *mut AnyObject = ptr::null_mut();
            let err_out: *mut *mut AnyObject = &mut err;
            msg_send![ident_cls, modelIdentifierFromLanguageTag: tag_ns, error: err_out]
        } else {
            msg_send![ident_cls, modelIdentifierForLanguageTag: tag_ns]
        };
        let _: () = msg_send![tag_ns, release];
        if identifier.is_null() {
            return Err(format!("No ML Kit ink model for language tag \"{tag}\""));
        }
        let model_cls = cls("MLKDigitalInkRecognitionModel")?;
        let model: *mut AnyObject = msg_send![model_cls, alloc];
        let model: *mut AnyObject = msg_send![model, initWithModelIdentifier: identifier];
        if model.is_null() {
            return Err("Failed to create ML Kit model".into());
        }
        Ok(model)
    }

    /// The per-language model (~20 MB) downloads on first use. Kick the
    /// download and poll — the notification-based completion API isn't
    /// worth bridging dynamically when a 500 ms poll does the job.
    unsafe fn ensure_model_downloaded(model: *mut AnyObject) -> Result<(), String> {
        let mm_cls = cls("MLKModelManager")?;
        let mm: *mut AnyObject = msg_send![mm_cls, modelManager];
        let downloaded: Bool = msg_send![mm, isModelDownloaded: model];
        if downloaded.as_bool() {
            return Ok(());
        }
        let cond_cls = cls("MLKModelDownloadConditions")?;
        let cond: *mut AnyObject = msg_send![cond_cls, alloc];
        let cond: *mut AnyObject = msg_send![
            cond,
            initWithAllowsCellularAccess: Bool::YES,
            allowsBackgroundDownloading: Bool::NO
        ];
        let _progress: *mut AnyObject = msg_send![mm, downloadModel: model, conditions: cond];
        let _: () = msg_send![cond, release];
        for _ in 0..120 {
            std::thread::sleep(Duration::from_millis(500));
            let ok: Bool = msg_send![mm, isModelDownloaded: model];
            if ok.as_bool() {
                return Ok(());
            }
        }
        Err("The ML Kit language model is still downloading — try again in a moment".into())
    }

    unsafe fn extract_top_candidate(
        result: *mut AnyObject,
        error: *mut AnyObject,
    ) -> Result<String, String> {
        if result.is_null() {
            return Err(describe_nserror(error, "ML Kit recognition failed"));
        }
        let candidates: *mut AnyObject = msg_send![result, candidates];
        if candidates.is_null() {
            return Ok(String::new());
        }
        let count: usize = msg_send![candidates, count];
        if count == 0 {
            return Ok(String::new());
        }
        let best: *mut AnyObject = msg_send![candidates, objectAtIndex: 0usize];
        let text: *mut AnyObject = msg_send![best, text];
        Ok(nsstring_to_string(text).unwrap_or_default())
    }
}
