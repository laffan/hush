/*!
 * Image file storage for doc image support.
 *
 * Images live under `{data_dir}/files/images/{filename}` as raw binary —
 * the on-disk filename *is* the stable id referenced from markdown. A file
 * dropped as `brown-cow.png` lands at `files/images/brown-cow.png` and is
 * referenced in docs as plain `![alt](brown-cow.png)`. If a file with the
 * same name already exists, we auto-suffix (`brown-cow (2).png`) so we
 * never clobber.
 *
 * Renames move the on-disk file in-place; the caller is responsible for
 * rewriting any doc references.
 */

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use std::fs;
use std::path::{Path, PathBuf};

pub struct ImageManager {
    images_dir: PathBuf,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageSaved {
    pub filename: String,
    pub mime_type: String,
    pub byte_size: u64,
}

impl ImageManager {
    pub fn new(images_dir: PathBuf) -> Self {
        fs::create_dir_all(&images_dir).ok();
        Self { images_dir }
    }

    /// Write an image from a data URL keeping the caller-supplied filename
    /// (auto-suffixing on collision). Returns the final filename used.
    pub fn save_from_data_url(
        &self,
        filename: &str,
        data_url: &str,
    ) -> Result<ImageSaved, Box<dyn std::error::Error>> {
        let (mime, bytes) = decode_data_url(data_url)?;
        let base = sanitize_filename(filename);
        let ext = pick_extension(&base, &mime);
        let final_name = self.unique_filename(&base, &ext);
        let path = self.resolve_path(&final_name)?;
        fs::write(&path, &bytes)?;
        Ok(ImageSaved {
            filename: final_name,
            mime_type: mime,
            byte_size: bytes.len() as u64,
        })
    }

    /// Return all filenames currently stored on disk, sorted.
    pub fn list(&self) -> Vec<String> {
        let mut out = Vec::new();
        if let Ok(rd) = fs::read_dir(&self.images_dir) {
            for entry in rd.flatten() {
                if let Some(name) = entry.file_name().to_str() {
                    if !name.starts_with('.') && entry.path().is_file() {
                        out.push(name.to_string());
                    }
                }
            }
        }
        out.sort();
        out
    }

    /// Read an image by filename and return it as a data URL.
    pub fn load_as_data_url(&self, filename: &str) -> Result<String, Box<dyn std::error::Error>> {
        let path = self.resolve_path(filename)?;
        let bytes = fs::read(&path)?;
        let mime = ext_for_path(&path).and_then(mime_for_ext)
            .unwrap_or_else(|| "application/octet-stream".to_string());
        Ok(format!("data:{};base64,{}", mime, B64.encode(&bytes)))
    }

    pub fn load_bytes(
        &self,
        filename: &str,
    ) -> Result<(Vec<u8>, String), Box<dyn std::error::Error>> {
        let path = self.resolve_path(filename)?;
        let bytes = fs::read(&path)?;
        let mime = ext_for_path(&path).and_then(mime_for_ext)
            .unwrap_or_else(|| "application/octet-stream".to_string());
        Ok((bytes, mime))
    }

    pub fn delete(&self, filename: &str) -> Result<(), Box<dyn std::error::Error>> {
        let path = self.resolve_path(filename)?;
        if path.exists() { fs::remove_file(&path)?; }
        Ok(())
    }

    /// Rename an image on disk. Returns the final name used (auto-suffixed
    /// if `new_name` already exists). Returns the existing name unchanged
    /// when rename is a no-op.
    pub fn rename(
        &self,
        old_name: &str,
        new_name: &str,
    ) -> Result<String, Box<dyn std::error::Error>> {
        if old_name == new_name { return Ok(old_name.to_string()); }
        let src = self.resolve_path(old_name)?;
        if !src.exists() { return Err("image not found".into()); }
        let sanitized = sanitize_filename(new_name);
        // Preserve the original extension when the new name lacks one.
        let final_name = if Path::new(&sanitized).extension().is_none() {
            let old_ext = ext_for_path(&src).unwrap_or_default();
            if !old_ext.is_empty() { format!("{}.{}", sanitized, old_ext) } else { sanitized }
        } else {
            sanitized
        };
        let base = Path::new(&final_name).file_stem().and_then(|s| s.to_str()).unwrap_or("image").to_string();
        let ext = Path::new(&final_name).extension().and_then(|s| s.to_str()).unwrap_or("").to_string();
        let final_name = self.unique_filename(&base, &ext);
        let dst = self.resolve_path(&final_name)?;
        fs::rename(&src, &dst)?;
        Ok(final_name)
    }

    fn unique_filename(&self, base: &str, ext: &str) -> String {
        let first = if ext.is_empty() { base.to_string() } else { format!("{}.{}", base, ext) };
        if !self.images_dir.join(&first).exists() { return first; }
        for i in 2..u32::MAX {
            let candidate = if ext.is_empty() {
                format!("{} {}", base, i)
            } else {
                format!("{} {}.{}", base, i, ext)
            };
            if !self.images_dir.join(&candidate).exists() { return candidate; }
        }
        first
    }

    fn resolve_path(&self, filename: &str) -> Result<PathBuf, Box<dyn std::error::Error>> {
        if filename.contains('/') || filename.contains('\\') || filename.contains("..") {
            return Err("invalid image filename".into());
        }
        if filename.starts_with('.') { return Err("invalid image filename".into()); }
        Ok(self.images_dir.join(filename))
    }
}

/// Strip path separators and OS-sensitive characters from a filename.
pub fn sanitize_filename(name: &str) -> String {
    let trimmed = name.trim();
    // Extract just the basename in case the caller handed us a path.
    let slash = trimmed.rfind(|c| c == '/' || c == '\\');
    let bare = match slash { Some(i) => &trimmed[i + 1..], None => trimmed };
    let cleaned: String = bare.chars()
        .map(|c| if "<>:\"|?*".contains(c) || c.is_control() { '_' } else { c })
        .collect();
    if cleaned.is_empty() { "image".to_string() } else { cleaned }
}

fn pick_extension(name: &str, mime: &str) -> String {
    if let Some(ext) = Path::new(name).extension().and_then(|s| s.to_str()) {
        return ext.to_ascii_lowercase();
    }
    ext_for_mime(mime).unwrap_or("bin").to_string()
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
    p.extension().and_then(|e| e.to_str()).map(|s| s.to_lowercase())
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
