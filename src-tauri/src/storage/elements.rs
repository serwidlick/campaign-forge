use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use walkdir::WalkDir;

use super::campaign::ELEMENTS_DIR;
use super::error::StorageError;
use super::frontmatter;
use super::links::extract_links;
use super::model::{
    Element, ElementMeta, ElementSummary, Extra, SaveElementInput, new_id, now_rfc3339,
};
use super::slug::slugify;

/// Walks `elements/` and returns every element's metadata plus an id -> path index.
pub fn scan(root: &Path) -> Result<(Vec<ElementSummary>, HashMap<String, PathBuf>), StorageError> {
    let dir = root.join(ELEMENTS_DIR);
    let mut summaries = Vec::new();
    let mut index = HashMap::new();
    if !dir.is_dir() {
        return Ok((summaries, index));
    }

    for entry in WalkDir::new(&dir).min_depth(2).max_depth(2) {
        let entry = entry.map_err(|e| StorageError::io(dir.clone(), std::io::Error::other(e)))?;
        let path = entry.path();
        let is_markdown = path.extension().and_then(|e| e.to_str()) == Some("md");
        if !entry.file_type().is_file() || !is_markdown {
            continue;
        }
        match read(root, path) {
            Ok(element) => {
                index.insert(element.meta.id.clone(), path.to_path_buf());
                summaries.push(element.summary());
            }
            Err(StorageError::InvalidFrontmatter { .. }) => {
                // Skip files we cannot parse rather than failing the whole scan.
                // The user may have a stray Markdown file in the folder.
                continue;
            }
            Err(other) => return Err(other),
        }
    }

    summaries.sort_by(|a, b| {
        a.meta
            .kind
            .cmp(&b.meta.kind)
            .then_with(|| a.meta.name.cmp(&b.meta.name))
    });
    Ok((summaries, index))
}

pub fn read(root: &Path, path: &Path) -> Result<Element, StorageError> {
    let text = fs::read_to_string(path).map_err(|e| StorageError::io(path, e))?;
    let (yaml, body) =
        frontmatter::split(&text).ok_or_else(|| StorageError::InvalidFrontmatter {
            path: path.to_path_buf(),
            reason: "missing frontmatter block".into(),
        })?;
    let mut meta: ElementMeta =
        serde_yaml_ng::from_str(yaml).map_err(|e| StorageError::InvalidFrontmatter {
            path: path.to_path_buf(),
            reason: e.to_string(),
        })?;
    meta.path = relative(root, path);
    Ok(Element {
        meta,
        links: extract_links(body),
        body: body.to_owned(),
    })
}

/// Frontmatter keys owned by `ElementMeta` or derived at runtime. They are
/// stripped from `extra` so a caller can never produce duplicate YAML keys.
const RESERVED_KEYS: [&str; 9] = [
    "id",
    "type",
    "name",
    "tags",
    "createdAt",
    "updatedAt",
    "path",
    "links",
    "body",
];

fn sanitize_extra(mut extra: Extra) -> Extra {
    for key in RESERVED_KEYS {
        extra.remove(key);
    }
    extra
}

pub fn create(
    root: &Path,
    kind: &str,
    name: &str,
    extra: Option<Extra>,
) -> Result<Element, StorageError> {
    let name = name.trim();
    if name.is_empty() {
        return Err(StorageError::InvalidInput("element name is empty".into()));
    }
    let kind_slug = slugify(kind);
    let dir = root.join(ELEMENTS_DIR).join(&kind_slug);
    fs::create_dir_all(&dir).map_err(|e| StorageError::io(&dir, e))?;

    let path = unique_path(&dir, &slugify(name));
    let now = now_rfc3339();
    let meta = ElementMeta {
        id: new_id(),
        kind: kind_slug,
        name: name.to_owned(),
        tags: Vec::new(),
        created_at: now.clone(),
        updated_at: now,
        path: relative(root, &path),
        extra: sanitize_extra(extra.unwrap_or_default()),
    };
    let body = format!("# {name}\n");
    write(&path, &meta, &body)?;
    Ok(Element {
        meta,
        links: Vec::new(),
        body,
    })
}

pub fn save(root: &Path, path: &Path, input: SaveElementInput) -> Result<Element, StorageError> {
    let existing = read(root, path)?;
    let name = input.name.trim();
    if name.is_empty() {
        return Err(StorageError::InvalidInput("element name is empty".into()));
    }
    let meta = ElementMeta {
        name: name.to_owned(),
        tags: input
            .tags
            .into_iter()
            .map(|t| t.trim().to_owned())
            .filter(|t| !t.is_empty())
            .collect(),
        updated_at: now_rfc3339(),
        extra: match input.extra {
            Some(extra) => sanitize_extra(extra),
            None => existing.meta.extra,
        },
        ..existing.meta
    };
    write(path, &meta, &input.body)?;
    Ok(Element {
        meta,
        links: extract_links(&input.body),
        body: input.body,
    })
}

pub fn delete(path: &Path) -> Result<(), StorageError> {
    fs::remove_file(path).map_err(|e| StorageError::io(path, e))
}

fn write(path: &Path, meta: &ElementMeta, body: &str) -> Result<(), StorageError> {
    // `path` is runtime-only and skipped when empty; clear it before writing.
    let mut persisted = meta.clone();
    persisted.path = String::new();
    let yaml = serde_yaml_ng::to_string(&persisted)?;
    let doc = frontmatter::join(&yaml, body);
    // Write to a sibling temp file and rename so a crash never leaves a
    // half-written element behind.
    let tmp = path.with_extension("md.tmp");
    fs::write(&tmp, doc).map_err(|e| StorageError::io(&tmp, e))?;
    fs::rename(&tmp, path).map_err(|e| StorageError::io(path, e))
}

fn unique_path(dir: &Path, slug: &str) -> PathBuf {
    let candidate = dir.join(format!("{slug}.md"));
    if !candidate.exists() {
        return candidate;
    }
    (2..)
        .map(|n| dir.join(format!("{slug}-{n}.md")))
        .find(|candidate| !candidate.exists())
        .expect("unbounded range always yields a free path")
}

pub(super) fn relative(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}
