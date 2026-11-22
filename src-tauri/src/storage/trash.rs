//! Recently deleted elements.
//!
//! Deleting an element moves its file to `<campaign>/.trash/<kind>/<slug>.md`
//! instead of removing it, with two keys added to the frontmatter: `deletedAt`,
//! when it was deleted, and `deletedFrom`, the path it had. Restoring writes
//! the file back under `elements/` with its original id, frontmatter and body,
//! so every link to it works again. Files deleted more than [`KEEP_DAYS`] ago
//! are removed when the campaign is opened.
//!
//! The folder sits beside `elements/`, not inside it, so the element scan,
//! the search and the table never see what is in it.

use std::fs;
use std::path::{Path, PathBuf};

use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use walkdir::WalkDir;

use super::campaign::ELEMENTS_DIR;
use super::elements;
use super::error::StorageError;
use super::model::{Element, ElementSummary, Extra, now_rfc3339};
use super::slug::slugify;

pub const TRASH_DIR: &str = ".trash";

/// How long a deleted element is kept before [`prune`] removes it for good.
pub const KEEP_DAYS: i64 = 30;

const DELETED_AT: &str = "deletedAt";
const DELETED_FROM: &str = "deletedFrom";

/// A deleted element as the "Recently deleted" list shows it. Its `path` is
/// the file's place under `.trash/`; `deleted_from` is where it came from.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrashedElement {
    #[serde(flatten)]
    pub summary: ElementSummary,
    pub deleted_at: String,
    pub deleted_from: String,
}

impl TrashedElement {
    fn from_element(element: &Element) -> Self {
        let mut meta = element.meta.clone();
        let deleted_at = take_string(&mut meta.extra, DELETED_AT);
        let deleted_from = take_string(&mut meta.extra, DELETED_FROM);
        Self {
            summary: ElementSummary {
                meta,
                links: element.links.clone(),
            },
            deleted_at,
            deleted_from,
        }
    }
}

fn take_string(extra: &mut Extra, key: &str) -> String {
    match extra.remove(key) {
        Some(serde_json::Value::String(s)) => s,
        _ => String::new(),
    }
}

/// The file stem to reuse for a moved file: its current one, else the name.
fn stem_of(path: &Path, name: &str) -> String {
    path.file_stem()
        .and_then(|s| s.to_str())
        .map(slugify)
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| slugify(name))
}

/// Moves the element at `path` into the trash and returns it as listed.
pub fn delete(root: &Path, path: &Path) -> Result<TrashedElement, StorageError> {
    let existing = elements::read(root, path)?;
    let dir = root.join(TRASH_DIR).join(&existing.meta.kind);
    fs::create_dir_all(&dir).map_err(|e| StorageError::io(&dir, e))?;
    let target = elements::unique_path(&dir, &stem_of(path, &existing.meta.name));

    let mut meta = existing.meta.clone();
    meta.extra
        .insert(DELETED_AT.to_owned(), now_rfc3339().into());
    meta.extra
        .insert(DELETED_FROM.to_owned(), existing.meta.path.clone().into());
    meta.path = elements::relative(root, &target);
    let version = elements::write(&target, &meta, &existing.body)?;
    // The copy is complete before the original goes, so a crash in between
    // leaves the element in both places, never in neither.
    fs::remove_file(path).map_err(|e| StorageError::io(path, e))?;
    Ok(TrashedElement::from_element(&Element {
        meta,
        links: existing.links,
        body: existing.body,
        version,
    }))
}

/// Every readable element file under `.trash/<kind>/`, with its path.
fn walk(root: &Path) -> Result<Vec<(PathBuf, Element)>, StorageError> {
    let dir = root.join(TRASH_DIR);
    let mut out = Vec::new();
    if !dir.is_dir() {
        return Ok(out);
    }
    for entry in WalkDir::new(&dir)
        .min_depth(2)
        .max_depth(2)
        .sort_by_file_name()
    {
        let entry = entry.map_err(|e| StorageError::io(dir.clone(), std::io::Error::other(e)))?;
        let path = entry.path();
        let is_markdown = path.extension().and_then(|e| e.to_str()) == Some("md");
        if !entry.file_type().is_file() || !is_markdown {
            continue;
        }
        match elements::read(root, path) {
            Ok(element) => out.push((path.to_path_buf(), element)),
            // A stray or half-written file is not an element; leave it be.
            Err(StorageError::InvalidFrontmatter { .. }) => continue,
            Err(other) => return Err(other),
        }
    }
    Ok(out)
}

/// Deleted elements, most recently deleted first.
pub fn list(root: &Path) -> Result<Vec<TrashedElement>, StorageError> {
    let mut out: Vec<TrashedElement> = walk(root)?
        .iter()
        .map(|(_, element)| TrashedElement::from_element(element))
        .collect();
    out.sort_by(|a, b| {
        b.deleted_at
            .cmp(&a.deleted_at)
            .then_with(|| a.summary.meta.name.cmp(&b.summary.meta.name))
    });
    Ok(out)
}

fn find(root: &Path, id: &str) -> Result<(PathBuf, Element), StorageError> {
    walk(root)?
        .into_iter()
        .find(|(_, element)| element.meta.id == id)
        .ok_or_else(|| StorageError::ElementNotFound(id.to_owned()))
}

/// Puts a deleted element back under `elements/`, at its old file name when
/// that is still free, with its id, frontmatter and body as they were.
pub fn restore(root: &Path, id: &str) -> Result<Element, StorageError> {
    let (trashed, element) = find(root, id)?;
    let mut meta = element.meta;
    let from = take_string(&mut meta.extra, DELETED_FROM);
    meta.extra.remove(DELETED_AT);

    let dir = root.join(ELEMENTS_DIR).join(&meta.kind);
    fs::create_dir_all(&dir).map_err(|e| StorageError::io(&dir, e))?;
    let old_name = Path::new(&from)
        .file_name()
        .and_then(|n| n.to_str())
        .filter(|n| n.ends_with(".md"))
        .map(|n| dir.join(n));
    let target = match old_name {
        Some(path) if !path.exists() => path,
        _ => elements::unique_path(&dir, &stem_of(&trashed, &meta.name)),
    };
    meta.path = elements::relative(root, &target);
    let version = elements::write(&target, &meta, &element.body)?;
    fs::remove_file(&trashed).map_err(|e| StorageError::io(&trashed, e))?;
    tidy(&trashed);
    Ok(Element {
        meta,
        links: element.links,
        body: element.body,
        version,
    })
}

/// Removes a deleted element for good.
pub fn purge(root: &Path, id: &str) -> Result<(), StorageError> {
    let (path, _) = find(root, id)?;
    fs::remove_file(&path).map_err(|e| StorageError::io(&path, e))?;
    tidy(&path);
    Ok(())
}

/// Removes elements deleted more than `keep` ago. Returns how many went.
pub fn prune(root: &Path, keep: Duration) -> Result<usize, StorageError> {
    let cutoff = Utc::now() - keep;
    let mut removed = 0;
    for (path, element) in walk(root)? {
        let deleted_at = element
            .meta
            .extra
            .get(DELETED_AT)
            .and_then(|v| v.as_str())
            .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
            .map(|t| t.with_timezone(&Utc));
        // A file put here by hand, without a date, counts from its last write.
        let deleted_at = match deleted_at {
            Some(t) => t,
            None => match fs::metadata(&path).and_then(|m| m.modified()) {
                Ok(mtime) => DateTime::<Utc>::from(mtime),
                Err(_) => continue,
            },
        };
        if deleted_at < cutoff {
            fs::remove_file(&path).map_err(|e| StorageError::io(&path, e))?;
            tidy(&path);
            removed += 1;
        }
    }
    Ok(removed)
}

/// Drops the kind folder a removed file leaves behind once it is empty.
/// Nothing depends on the folder, so a failure here is not an error.
fn tidy(removed: &Path) {
    if let Some(dir) = removed.parent() {
        let _ = fs::remove_dir(dir);
    }
}
