/// Small shared helpers for the Objective-C bridges (Vision and
/// ML Kit handwriting recognition). Apple targets only.
use objc2::msg_send;
use objc2::runtime::AnyObject;
use std::ffi::{c_char, c_void, CStr};

pub unsafe fn nsstring_to_string(s: *mut AnyObject) -> Option<String> {
    if s.is_null() {
        return None;
    }
    let utf8: *const c_char = msg_send![s, UTF8String];
    if utf8.is_null() {
        return None;
    }
    Some(CStr::from_ptr(utf8).to_string_lossy().into_owned())
}

/// Build an owned NSString (caller releases). Avoids CString by using
/// initWithBytes:length:encoding: (NSUTF8StringEncoding = 4).
/// Only the iOS-only ML Kit bridge needs it, so macOS builds see it
/// as unused.
#[cfg_attr(target_os = "macos", allow(dead_code))]
pub unsafe fn nsstring_from_str(s: &str) -> Result<*mut AnyObject, String> {
    let cls = objc2::class!(NSString);
    let ns: *mut AnyObject = msg_send![cls, alloc];
    let ns: *mut AnyObject = msg_send![
        ns,
        initWithBytes: s.as_ptr() as *const c_void,
        length: s.len(),
        encoding: 4usize
    ];
    if ns.is_null() {
        return Err("Failed to build NSString".into());
    }
    Ok(ns)
}

pub unsafe fn describe_nserror(err: *mut AnyObject, fallback: &str) -> String {
    if err.is_null() {
        return fallback.into();
    }
    let desc: *mut AnyObject = msg_send![err, localizedDescription];
    nsstring_to_string(desc).unwrap_or_else(|| fallback.into())
}

/// Render an NSException caught by `objc2::exception::catch` into a
/// readable command error — a wrong selector in the dynamic bridges
/// raises instead of returning, and without this the app would abort.
pub fn describe_objc_exception(
    ex: Option<objc2::rc::Id<objc2::exception::Exception>>,
    what: &str,
) -> String {
    match ex {
        Some(e) => unsafe {
            let ptr = &*e as *const objc2::exception::Exception as *mut AnyObject;
            let name: *mut AnyObject = msg_send![ptr, name];
            let reason: *mut AnyObject = msg_send![ptr, reason];
            format!(
                "Objective-C exception in {what}: {} — {}",
                nsstring_to_string(name).unwrap_or_else(|| "?".into()),
                nsstring_to_string(reason).unwrap_or_else(|| "no reason given".into()),
            )
        },
        None => format!("Unknown Objective-C exception in {what}"),
    }
}
