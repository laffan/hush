/*!
 * Image file storage for doc image support.
 *
 * Images live inside their desk's folder — `{data_dir}/desks/<id>/Images/{filename}`
 * — as raw binary; the filename *is* the stable id referenced from
 * markdown (`![alt](brown-cow.png)`). Reads resolve by searching every
 * desk's `Images/` directory (refs are desk-agnostic filenames), with the
 * pre-desks `{data_dir}/files/images/` location kept as a read-only
 * legacy fallback. New saves land in the active desk's `Images/`; the
 * filename is auto-suffixed (`brown-cow (2).png`) across *all* locations
 * so two desks can never mint the same ambiguous name.
 *
 * Renames move the on-disk file in place (same directory); the caller is
 * responsible for rewriting any doc references.
 */

use crate::atomic::write_atomic;
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use std::fs;
use std::path::{Path, PathBuf};

pub struct ImageManager {
    legacy_dir: PathBuf,
    desks_dir: PathBuf,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageSaved {
    pub filename: String,
    pub mime_type: String,
    pub byte_size: u64,
}

impl ImageManager {
    pub fn new(legacy_dir: PathBuf, desks_dir: PathBuf) -> Self {
        fs::create_dir_all(&legacy_dir).ok();
        Self { legacy_dir, desks_dir }
    }

    /// Every directory that may hold image binaries: each desk's Images/
    /// plus the legacy flat location.
    fn search_dirs(&self) -> Vec<PathBuf> {
        let mut out = Vec::new();
        if let Ok(rd) = fs::read_dir(&self.desks_dir) {
            for entry in rd.flatten() {
                let name = entry.file_name().to_string_lossy().into_owned();
                if name.starts_with('.') || !entry.path().is_dir() {
                    continue;
                }
                let images = entry.path().join("Images");
                if images.is_dir() {
                    out.push(images);
                }
            }
        }
        // Local desks live outside desks_dir — resolve their Images/
        // through the same roots map DeskStore uses.
        for (_desk_id, root) in crate::desk_roots::load_roots(&self.desks_dir) {
            let images = PathBuf::from(root).join("Images");
            if images.is_dir() && !out.contains(&images) {
                out.push(images);
            }
        }
        out.push(self.legacy_dir.clone());
        out
    }

    /// Resolve a filename to its on-disk path, searching desks then legacy.
    fn find(&self, filename: &str) -> Option<PathBuf> {
        validate_filename(filename).ok()?;
        self.search_dirs()
            .into_iter()
            .map(|d| d.join(filename))
            .find(|p| p.exists())
    }

    /// Directory new saves land in: the given desk's Images/ (created on
    /// demand), else the legacy dir (fresh installs before a desk exists).
    fn target_dir(&self, desk_id: Option<&str>) -> PathBuf {
        if let Some(id) = desk_id {
            // Local desks resolve through roots.json, same as DeskStore.
            let base = crate::desk_roots::root_for(&self.desks_dir, id)
                .unwrap_or_else(|| self.desks_dir.join(id));
            let dir = base.join("Images");
            if fs::create_dir_all(&dir).is_ok() {
                return dir;
            }
        }
        self.legacy_dir.clone()
    }

    /// Write an image from a data URL keeping the caller-supplied filename
    /// (auto-suffixing on collision). Returns the final filename used.
    pub fn save_from_data_url(
        &self,
        filename: &str,
        data_url: &str,
        desk_id: Option<&str>,
    ) -> Result<ImageSaved, Box<dyn std::error::Error>> {
        let (mime, bytes) = decode_data_url(data_url)?;
        self.save_bytes_with_mime(filename, &bytes, Some(&mime), desk_id)
    }

    /// Write raw image bytes keeping the caller-supplied filename
    /// (auto-suffixing on collision). The MIME type is inferred from the
    /// filename extension.
    pub fn save_from_bytes(
        &self,
        filename: &str,
        bytes: &[u8],
        desk_id: Option<&str>,
    ) -> Result<ImageSaved, Box<dyn std::error::Error>> {
        self.save_bytes_with_mime(filename, bytes, None, desk_id)
    }

    fn save_bytes_with_mime(
        &self,
        filename: &str,
        bytes: &[u8],
        mime_hint: Option<&str>,
        desk_id: Option<&str>,
    ) -> Result<ImageSaved, Box<dyn std::error::Error>> {
        let base = sanitize_filename(filename);
        let (stem, mut ext) = split_name(&base);
        if ext.is_empty() {
            ext = mime_hint
                .and_then(ext_for_mime)
                .map(|s| s.to_string())
                .unwrap_or_else(|| "bin".to_string());
        }
        let final_name = self.unique_filename(&stem, &ext);
        let path = self.target_dir(desk_id).join(&final_name);
        write_atomic(&path, bytes)?;
        let mime = mime_hint
            .map(|s| s.to_string())
            .or_else(|| mime_for_ext(ext.clone()))
            .unwrap_or_else(|| "application/octet-stream".to_string());
        Ok(ImageSaved {
            filename: final_name,
            mime_type: mime,
            byte_size: bytes.len() as u64,
        })
    }

    /// Return all filenames currently stored on disk (all desks + legacy),
    /// deduped and sorted.
    pub fn list(&self) -> Vec<String> {
        let mut out: Vec<String> = Vec::new();
        for dir in self.search_dirs() {
            if let Ok(rd) = fs::read_dir(&dir) {
                for entry in rd.flatten() {
                    if let Some(name) = entry.file_name().to_str() {
                        if !name.starts_with('.') && entry.path().is_file() {
                            out.push(name.to_string());
                        }
                    }
                }
            }
        }
        out.sort();
        out.dedup();
        out
    }

    /// Read an image by filename and return it as a data URL.
    pub fn load_as_data_url(&self, filename: &str) -> Result<String, Box<dyn std::error::Error>> {
        let path = self.find(filename).ok_or("image not found")?;
        let bytes = fs::read(&path)?;
        let mime = ext_for_path(&path).and_then(mime_for_ext)
            .unwrap_or_else(|| "application/octet-stream".to_string());
        Ok(format!("data:{};base64,{}", mime, B64.encode(&bytes)))
    }

    pub fn load_bytes(
        &self,
        filename: &str,
    ) -> Result<(Vec<u8>, String), Box<dyn std::error::Error>> {
        let path = self.find(filename).ok_or("image not found")?;
        let bytes = fs::read(&path)?;
        let mime = ext_for_path(&path).and_then(mime_for_ext)
            .unwrap_or_else(|| "application/octet-stream".to_string());
        Ok((bytes, mime))
    }

    pub fn delete(&self, filename: &str) -> Result<(), Box<dyn std::error::Error>> {
        if let Some(path) = self.find(filename) {
            fs::remove_file(&path)?;
        }
        Ok(())
    }

    /// Rename an image on disk, keeping it in its current directory.
    /// Returns the final name used (auto-suffixed if `new_name` already
    /// exists anywhere). Returns the existing name unchanged on a no-op.
    pub fn rename(
        &self,
        old_name: &str,
        new_name: &str,
    ) -> Result<String, Box<dyn std::error::Error>> {
        if old_name == new_name { return Ok(old_name.to_string()); }
        let src = self.find(old_name).ok_or("image not found")?;
        let sanitized = sanitize_filename(new_name);
        let (stem, mut ext) = split_name(&sanitized);
        if ext.is_empty() {
            // Preserve the original extension when the new name dropped it.
            ext = ext_for_path(&src).unwrap_or_default();
        }
        let final_name = self.unique_filename(&stem, &ext);
        validate_filename(&final_name)?;
        let dst = src.parent().ok_or("bad image path")?.join(&final_name);
        fs::rename(&src, &dst)?;
        Ok(final_name)
    }

    /// A name unused in *every* image location — refs are desk-agnostic
    /// filenames, so uniqueness has to be global.
    fn unique_filename(&self, base: &str, ext: &str) -> String {
        let taken = |name: &str| self.find(name).is_some();
        let first = if ext.is_empty() { base.to_string() } else { format!("{}.{}", base, ext) };
        if !taken(&first) { return first; }
        for i in 2..u32::MAX {
            let candidate = if ext.is_empty() {
                format!("{} {}", base, i)
            } else {
                format!("{} ({}).{}", base, i, ext)
            };
            if !taken(&candidate) { return candidate; }
        }
        first
    }
}

fn validate_filename(filename: &str) -> Result<(), Box<dyn std::error::Error>> {
    if filename.contains('/') || filename.contains('\\') || filename.contains("..") {
        return Err("invalid image filename".into());
    }
    if filename.starts_with('.') { return Err("invalid image filename".into()); }
    Ok(())
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

fn split_name(name: &str) -> (String, String) {
    let p = Path::new(name);
    let stem = p.file_stem().and_then(|s| s.to_str()).unwrap_or(name).to_string();
    let ext = p.extension().and_then(|s| s.to_str()).map(|s| s.to_ascii_lowercase()).unwrap_or_default();
    (stem, ext)
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
