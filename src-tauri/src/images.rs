/*!
 * Image file storage for doc image support.
 *
 * Images live under `{data_dir}/files/images/{fileId}` as raw binary where
 * `fileId` is `{uuid}.{ext}` — the extension is kept in the id so lookups
 * by filename are direct and we know how to serve the file as a data URL
 * without tracking mime types separately.
 *
 * The tree carries an `image` node type with a `file_id` pointing at the
 * binary. Names on the tree node are independent of the on-disk filename
 * so images can be renamed without touching the backing file.
 */

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use std::fs;
use std::path::{Path, PathBuf};
use uuid::Uuid;

pub struct ImageManager {
    images_dir: PathBuf,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageSaved {
    pub file_id: String,
    pub mime_type: String,
    pub byte_size: u64,
}

impl ImageManager {
    pub fn new(images_dir: PathBuf) -> Self {
        fs::create_dir_all(&images_dir).ok();
        Self { images_dir }
    }

    /// Write an image from a data URL (`data:image/png;base64,...`) to disk.
    /// Returns the `file_id` ("uuid.ext") that can be used to look the file up.
    pub fn save_from_data_url(
        &self,
        data_url: &str,
    ) -> Result<ImageSaved, Box<dyn std::error::Error>> {
        let (mime, bytes) = decode_data_url(data_url)?;
        let ext = ext_for_mime(&mime).unwrap_or("bin");
        let file_id = format!("{}.{}", Uuid::new_v4(), ext);
        let path = self.images_dir.join(&file_id);
        fs::write(&path, &bytes)?;
        Ok(ImageSaved {
            file_id,
            mime_type: mime,
            byte_size: bytes.len() as u64,
        })
    }

    /// Read an image by `file_id` and return it as a data URL.
    pub fn load_as_data_url(&self, file_id: &str) -> Result<String, Box<dyn std::error::Error>> {
        let path = self.resolve_path(file_id)?;
        let bytes = fs::read(&path)?;
        let mime = ext_for_path(&path)
            .and_then(mime_for_ext)
            .unwrap_or_else(|| "application/octet-stream".to_string());
        Ok(format!("data:{};base64,{}", mime, B64.encode(&bytes)))
    }

    /// Read an image's raw bytes and detected mime type. Used by the export
    /// path so we can write the image next to the markdown text.
    pub fn load_bytes(
        &self,
        file_id: &str,
    ) -> Result<(Vec<u8>, String), Box<dyn std::error::Error>> {
        let path = self.resolve_path(file_id)?;
        let bytes = fs::read(&path)?;
        let mime = ext_for_path(&path)
            .and_then(mime_for_ext)
            .unwrap_or_else(|| "application/octet-stream".to_string());
        Ok((bytes, mime))
    }

    pub fn delete(&self, file_id: &str) -> Result<(), Box<dyn std::error::Error>> {
        let path = self.resolve_path(file_id)?;
        if path.exists() {
            fs::remove_file(&path)?;
        }
        Ok(())
    }

    /// Extension of the stored file (e.g. "png"). Used during export so the
    /// exported filename keeps the original format's extension.
    pub fn extension_of(&self, file_id: &str) -> Option<String> {
        Path::new(file_id)
            .extension()
            .and_then(|e| e.to_str())
            .map(|s| s.to_lowercase())
    }

    fn resolve_path(&self, file_id: &str) -> Result<PathBuf, Box<dyn std::error::Error>> {
        // Reject any path traversal (file_id should be a bare filename).
        if file_id.contains('/') || file_id.contains('\\') || file_id.contains("..") {
            return Err("invalid image file id".into());
        }
        Ok(self.images_dir.join(file_id))
    }
}

fn decode_data_url(s: &str) -> Result<(String, Vec<u8>), Box<dyn std::error::Error>> {
    let rest = s.strip_prefix("data:").ok_or("not a data URL")?;
    let comma = rest.find(',').ok_or("malformed data URL")?;
    let meta = &rest[..comma];
    let payload = &rest[comma + 1..];
    let (mime, is_b64) = match meta.rsplit_once(';') {
        Some((m, "base64")) => (m, true),
        _ => (meta, false),
    };
    let mime = if mime.is_empty() { "application/octet-stream" } else { mime };
    let bytes = if is_b64 {
        B64.decode(payload.as_bytes())?
    } else {
        // Percent-decode url-safe form. We don't expect non-base64 image
        // payloads in practice, but handle it just in case.
        urlencoding_decode(payload)
    };
    Ok((mime.to_string(), bytes))
}

fn urlencoding_decode(s: &str) -> Vec<u8> {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(v) = u8::from_str_radix(
                std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or("00"),
                16,
            ) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    out
}

fn ext_for_path(p: &Path) -> Option<String> {
    p.extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_lowercase())
}

fn ext_for_mime(mime: &str) -> Option<&'static str> {
    match mime.to_ascii_lowercase().as_str() {
        "image/png" => Some("png"),
        "image/jpeg" | "image/jpg" => Some("jpg"),
        "image/gif" => Some("gif"),
        "image/webp" => Some("webp"),
        "image/svg+xml" => Some("svg"),
        "image/bmp" => Some("bmp"),
        "image/heic" => Some("heic"),
        "image/heif" => Some("heif"),
        "image/avif" => Some("avif"),
        "image/tiff" => Some("tiff"),
        _ => None,
    }
}

fn mime_for_ext(ext: String) -> Option<String> {
    Some(match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "bmp" => "image/bmp",
        "heic" => "image/heic",
        "heif" => "image/heif",
        "avif" => "image/avif",
        "tiff" | "tif" => "image/tiff",
        _ => return None,
    }.to_string())
}
