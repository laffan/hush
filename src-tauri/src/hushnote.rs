//! `.hushnote` zip codec — the Rust twin of `src/sync/notebook-sync.js`.
//!
//! A `.hushnote` is a ZIP archive containing:
//!   data.json   — the notebook envelope (shapes + layers + flowEdges) with
//!                 image dataUrls in shapes replaced by relative paths
//!                 ("images/img_N.png") into the zip
//!   images/     — extracted image binaries
//!
//! Internal (in-memory) notebook content keeps images inline as base64
//! dataUrls; the on-disk form extracts them so the file is portable and
//! smaller. `pack` and `unpack` here mirror `packNotebook` /
//! `unpackNotebook` in JS byte-for-byte in *semantics* (not bytes — zip
//! metadata differs) so a desk folder written by Rust round-trips through
//! the JS export/import paths and vice versa.

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use serde_json::Value;
use std::io::{Cursor, Read, Write};
use zip::write::FileOptions;

type BoxError = Box<dyn std::error::Error>;

/// Pack a notebook's internal JSON content (envelope or legacy bare
/// `Shape[]`) into `.hushnote` zip bytes. Always emits the envelope form
/// inside the zip.
pub fn pack(json_content: &str) -> Result<Vec<u8>, BoxError> {
    let parsed: Value = if json_content.trim().is_empty() {
        Value::Array(Vec::new())
    } else {
        serde_json::from_str(json_content).unwrap_or(Value::Array(Vec::new()))
    };

    // Normalise to the envelope shape.
    let mut envelope = match parsed {
        Value::Array(shapes) => serde_json::json!({
            "format": "hushnote", "version": 1, "shapes": shapes,
        }),
        Value::Object(mut map) => {
            if !map.contains_key("shapes") {
                map.insert("shapes".to_string(), Value::Array(Vec::new()));
            }
            map.entry("format".to_string()).or_insert(Value::String("hushnote".into()));
            map.entry("version".to_string()).or_insert(Value::Number(1.into()));
            Value::Object(map)
        }
        _ => serde_json::json!({ "format": "hushnote", "version": 1, "shapes": [] }),
    };

    // Extract embedded images: shapes[].dataUrl beginning "data:" become
    // zip entries under images/ with the shape field rewritten to the
    // relative path.
    let mut images: Vec<(String, Vec<u8>)> = Vec::new();
    if let Some(shapes) = envelope.get_mut("shapes").and_then(|v| v.as_array_mut()) {
        let mut counter = 1u32;
        for shape in shapes.iter_mut() {
            let Some(obj) = shape.as_object_mut() else { continue };
            let Some(data_url) = obj.get("dataUrl").and_then(|v| v.as_str()) else { continue };
            if !data_url.starts_with("data:") {
                continue;
            }
            let Some((mime, bytes)) = decode_data_url(data_url) else { continue };
            let filename = format!("img_{}{}", counter, ext_for_mime(&mime));
            counter += 1;
            obj.insert(
                "dataUrl".to_string(),
                Value::String(format!("images/{}", filename)),
            );
            images.push((filename, bytes));
        }
    }

    let mut cursor = Cursor::new(Vec::new());
    {
        let mut zip = zip::ZipWriter::new(&mut cursor);
        let opts: FileOptions =
            FileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        zip.start_file("data.json", opts)?;
        zip.write_all(serde_json::to_string(&envelope)?.as_bytes())?;
        // Images are already compressed formats — store them raw.
        let raw: FileOptions =
            FileOptions::default().compression_method(zip::CompressionMethod::Stored);
        for (name, bytes) in &images {
            zip.start_file(format!("images/{}", name), raw)?;
            zip.write_all(bytes)?;
        }
        zip.finish()?;
    }
    Ok(cursor.into_inner())
}

/// Unpack `.hushnote` zip bytes back into the internal JSON content
/// string, re-inlining any images/ entries as base64 dataUrls. Bytes that
/// aren't a zip are assumed to be a raw JSON payload (legacy / hand-made
/// files) and returned as-is.
pub fn unpack(bytes: &[u8]) -> Result<String, BoxError> {
    if !bytes.starts_with(b"PK") {
        return Ok(String::from_utf8_lossy(bytes).into_owned());
    }
    let mut zip = zip::ZipArchive::new(Cursor::new(bytes))?;

    let mut data = String::new();
    zip.by_name("data.json")?.read_to_string(&mut data)?;
    let mut envelope: Value = serde_json::from_str(&data)?;

    // Collect the image entries once, then rewrite refs.
    let mut image_data: std::collections::HashMap<String, String> =
        std::collections::HashMap::new();
    for i in 0..zip.len() {
        let mut entry = zip.by_index(i)?;
        let name = entry.name().to_string();
        if !name.starts_with("images/") || entry.is_dir() {
            continue;
        }
        let mut buf = Vec::new();
        entry.read_to_end(&mut buf)?;
        let ext = name.rsplit('.').next().unwrap_or("png");
        image_data.insert(
            name.clone(),
            format!("data:{};base64,{}", mime_for_ext(ext), B64.encode(&buf)),
        );
    }

    if let Some(shapes) = envelope.get_mut("shapes").and_then(|v| v.as_array_mut()) {
        for shape in shapes.iter_mut() {
            let Some(obj) = shape.as_object_mut() else { continue };
            let Some(path) = obj.get("dataUrl").and_then(|v| v.as_str()) else { continue };
            if let Some(data_url) = image_data.get(path) {
                obj.insert("dataUrl".to_string(), Value::String(data_url.clone()));
            }
        }
    }

    Ok(serde_json::to_string(&envelope)?)
}

fn decode_data_url(s: &str) -> Option<(String, Vec<u8>)> {
    let rest = s.strip_prefix("data:")?;
    let comma = rest.find(',')?;
    let meta = &rest[..comma];
    let payload = &rest[comma + 1..];
    let (mime, is_b64) = match meta.rsplit_once(';') {
        Some((m, "base64")) => (m, true),
        _ => (meta, false),
    };
    if !is_b64 {
        return None; // notebook images are always base64
    }
    let bytes = B64.decode(payload.as_bytes()).ok()?;
    Some((mime.to_string(), bytes))
}

fn ext_for_mime(mime: &str) -> &'static str {
    match mime.to_ascii_lowercase().as_str() {
        "image/jpeg" | "image/jpg" => ".jpg",
        "image/webp" => ".webp",
        "image/gif" => ".gif",
        "image/svg+xml" => ".svg",
        _ => ".png",
    }
}

fn mime_for_ext(ext: &str) -> &'static str {
    match ext.to_ascii_lowercase().as_str() {
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "svg" => "image/svg+xml",
        _ => "image/png",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_envelope_with_embedded_image() {
        let px = B64.encode([137u8, 80, 78, 71]); // arbitrary bytes
        let content = format!(
            r#"{{"format":"hushnote","version":1,"shapes":[{{"id":"a","type":"image","dataUrl":"data:image/png;base64,{px}"}},{{"id":"b","type":"text","text":"hi"}}]}}"#
        );
        let zipped = pack(&content).unwrap();
        assert!(zipped.starts_with(b"PK"));
        let back = unpack(&zipped).unwrap();
        let v: Value = serde_json::from_str(&back).unwrap();
        let shapes = v["shapes"].as_array().unwrap();
        assert_eq!(shapes.len(), 2);
        assert!(shapes[0]["dataUrl"].as_str().unwrap().starts_with("data:image/png;base64,"));
        assert_eq!(shapes[1]["text"], "hi");
    }

    #[test]
    fn accepts_legacy_bare_array_and_plain_bytes() {
        let zipped = pack("[]").unwrap();
        let back = unpack(&zipped).unwrap();
        let v: Value = serde_json::from_str(&back).unwrap();
        assert_eq!(v["format"], "hushnote");
        assert_eq!(v["shapes"].as_array().unwrap().len(), 0);

        // Non-zip bytes pass through untouched.
        let raw = r#"{"format":"hushnote","version":1,"shapes":[]}"#;
        assert_eq!(unpack(raw.as_bytes()).unwrap(), raw);
    }
}
