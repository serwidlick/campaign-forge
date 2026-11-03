//! Binary assets that belong to a campaign: map images, element portraits
//! and PDF documents.
//!
//! Assets live under `<campaign root>/assets/<group>/<slug>.<ext>` and are
//! referenced from element frontmatter by that relative path. They are served
//! to the webview through a command rather than the asset protocol so no
//! filesystem scope has to be configured for arbitrary campaign folders.

use std::fs;
use std::path::{Component, Path, PathBuf};

use serde::Serialize;

use super::elements::relative;
use super::error::StorageError;
use super::slug::slugify;

pub const ASSETS_DIR: &str = "assets";

/// Generous ceiling for a single map image.
pub const MAX_IMAGE_BYTES: usize = 100 * 1024 * 1024;

/// Ceiling for a document such as a scanned rulebook.
pub const MAX_DOCUMENT_BYTES: u64 = 300 * 1024 * 1024;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedDocument {
    /// Path relative to the campaign root, forward slashes.
    pub path: String,
    pub bytes: u64,
    /// The source file's name without extension, for display.
    pub name: String,
}

/// Copies a PDF from anywhere on disk into `assets/<group>/`, keeping a slug
/// of its file name. Only real PDFs are accepted; nothing is overwritten.
pub fn import_document(
    root: &Path,
    group: &str,
    source: &Path,
) -> Result<ImportedDocument, StorageError> {
    let meta = fs::metadata(source).map_err(|e| StorageError::io(source, e))?;
    if meta.len() > MAX_DOCUMENT_BYTES {
        return Err(StorageError::InvalidInput(format!(
            "document is too large ({} MB; limit is {} MB)",
            meta.len() / (1024 * 1024),
            MAX_DOCUMENT_BYTES / (1024 * 1024)
        )));
    }
    let bytes = fs::read(source).map_err(|e| StorageError::io(source, e))?;
    if !bytes.starts_with(b"%PDF-") {
        return Err(StorageError::InvalidInput(
            "that does not look like a PDF file".into(),
        ));
    }
    let name = source
        .file_stem()
        .and_then(|s| s.to_str())
        .filter(|s| !s.trim().is_empty())
        .unwrap_or("document")
        .to_owned();
    let dir = root.join(ASSETS_DIR).join(slugify(group));
    fs::create_dir_all(&dir).map_err(|e| StorageError::io(&dir, e))?;
    let target = unique_path(&dir, &slugify(&name), "pdf");
    fs::write(&target, &bytes).map_err(|e| StorageError::io(&target, e))?;
    Ok(ImportedDocument {
        path: relative(root, &target),
        bytes: bytes.len() as u64,
        name,
    })
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedImage {
    /// Path relative to the campaign root, forward slashes.
    pub path: String,
    pub width: u32,
    pub height: u32,
}

/// Reads an image from anywhere on disk and imports it. See [`import_image_bytes`].
pub fn import_image(
    root: &Path,
    group: &str,
    stem: &str,
    source: &Path,
) -> Result<ImportedImage, StorageError> {
    let bytes = fs::read(source).map_err(|e| StorageError::io(source, e))?;
    import_image_bytes(root, group, stem, &bytes)
}

/// Stores image bytes under `assets/<group>/` and reports their pixel size.
/// The format is sniffed from the bytes, so the caller does not need to know
/// or trust a file extension. An existing file is never overwritten.
pub fn import_image_bytes(
    root: &Path,
    group: &str,
    stem: &str,
    bytes: &[u8],
) -> Result<ImportedImage, StorageError> {
    if bytes.len() > MAX_IMAGE_BYTES {
        return Err(StorageError::InvalidInput(format!(
            "image is too large ({} MB; limit is {} MB)",
            bytes.len() / (1024 * 1024),
            MAX_IMAGE_BYTES / (1024 * 1024)
        )));
    }
    let ext = match imagesize::image_type(bytes) {
        Ok(imagesize::ImageType::Png) => "png",
        Ok(imagesize::ImageType::Jpeg) => "jpg",
        Ok(imagesize::ImageType::Webp) => "webp",
        Ok(imagesize::ImageType::Gif) => "gif",
        Ok(other) => {
            return Err(StorageError::InvalidInput(format!(
                "unsupported image type {other:?} (use png, jpg, webp or gif)"
            )));
        }
        Err(_) => {
            return Err(StorageError::InvalidInput(
                "that does not look like an image file".into(),
            ));
        }
    };
    let size = imagesize::blob_size(bytes)
        .map_err(|e| StorageError::InvalidInput(format!("cannot read image dimensions: {e}")))?;

    let dir = root.join(ASSETS_DIR).join(slugify(group));
    fs::create_dir_all(&dir).map_err(|e| StorageError::io(&dir, e))?;
    let target = unique_path(&dir, &slugify(stem), ext);
    fs::write(&target, bytes).map_err(|e| StorageError::io(&target, e))?;

    Ok(ImportedImage {
        path: relative(root, &target),
        width: u32::try_from(size.width).unwrap_or(u32::MAX),
        height: u32::try_from(size.height).unwrap_or(u32::MAX),
    })
}

/// Reads an asset by its campaign-relative path. Refuses anything that is not
/// a plain path under `assets/`.
pub fn read(root: &Path, rel: &str) -> Result<Vec<u8>, StorageError> {
    let rel_path = Path::new(rel);
    let safe = rel_path
        .components()
        .all(|c| matches!(c, Component::Normal(_)))
        && rel_path.components().next() == Some(Component::Normal(ASSETS_DIR.as_ref()));
    if !safe {
        return Err(StorageError::InvalidInput(format!(
            "asset path must be a plain path under {ASSETS_DIR}/: {rel}"
        )));
    }
    let full = root.join(rel_path);
    fs::read(&full).map_err(|e| StorageError::io(&full, e))
}

fn unique_path(dir: &Path, slug: &str, ext: &str) -> PathBuf {
    let candidate = dir.join(format!("{slug}.{ext}"));
    if !candidate.exists() {
        return candidate;
    }
    (2..)
        .map(|n| dir.join(format!("{slug}-{n}.{ext}")))
        .find(|candidate| !candidate.exists())
        .expect("unbounded range always yields a free path")
}

#[cfg(test)]
mod tests {
    use super::{StorageError, import_image_bytes, read};

    /// Smallest valid PNG: 1x1 pixel.
    const PNG_1X1: &[u8] = &[
        0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44,
        0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1F,
        0x15, 0xC4, 0x89, 0x00, 0x00, 0x00, 0x0A, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9C, 0x63, 0x00,
        0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0D, 0x0A, 0x2D, 0xB4, 0x00, 0x00, 0x00, 0x00, 0x49,
        0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82,
    ];

    #[test]
    fn read_rejects_escapes_and_paths_outside_assets() {
        let root = std::env::temp_dir();
        for bad in [
            "../x.png",
            "assets/../x.png",
            "elements/x.md",
            "/etc/passwd",
        ] {
            assert!(
                matches!(read(&root, bad), Err(StorageError::InvalidInput(_))),
                "{bad} should be rejected"
            );
        }
    }

    #[test]
    fn imports_bytes_by_sniffed_type_and_reads_them_back() {
        let root = std::env::temp_dir().join(format!("cf-assets-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();

        let imported = import_image_bytes(&root, "maps", "Sword Coast", PNG_1X1).unwrap();
        assert_eq!(imported.path, "assets/maps/sword-coast.png");
        assert_eq!((imported.width, imported.height), (1, 1));
        assert_eq!(read(&root, &imported.path).unwrap(), PNG_1X1);

        // Same stem again gets a new file, not an overwrite.
        let again = import_image_bytes(&root, "maps", "Sword Coast", PNG_1X1).unwrap();
        assert_eq!(again.path, "assets/maps/sword-coast-2.png");

        // Not an image.
        assert!(matches!(
            import_image_bytes(&root, "maps", "x", b"hello"),
            Err(StorageError::InvalidInput(_))
        ));

        let _ = std::fs::remove_dir_all(&root);
    }
}
