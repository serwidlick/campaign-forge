use std::fs;
use std::path::Path;

use super::error::StorageError;
use super::model::{CampaignMeta, Extra, new_id, now_rfc3339};

pub const CAMPAIGN_FILE: &str = "campaign.json";
pub const ELEMENTS_DIR: &str = "elements";

pub fn create(root: &Path, name: &str, system: Option<&str>) -> Result<CampaignMeta, StorageError> {
    let name = name.trim();
    if name.is_empty() {
        return Err(StorageError::InvalidInput("campaign name is empty".into()));
    }
    if root.join(CAMPAIGN_FILE).exists() {
        return Err(StorageError::AlreadyACampaign(root.to_path_buf()));
    }
    fs::create_dir_all(root.join(ELEMENTS_DIR)).map_err(|e| StorageError::io(root, e))?;

    let now = now_rfc3339();
    let meta = CampaignMeta {
        id: new_id(),
        name: name.to_owned(),
        system: system
            .map(|s| s.trim().to_owned())
            .filter(|s| !s.is_empty()),
        created_at: now.clone(),
        updated_at: now,
        path: root.to_string_lossy().into_owned(),
        extra: Extra::new(),
    };
    write_meta(root, &meta)?;
    Ok(meta)
}

/// Keys owned by `CampaignMeta` itself; stripped from `extra` so a caller can
/// never produce duplicate JSON keys.
const RESERVED_KEYS: [&str; 6] = ["id", "name", "system", "createdAt", "updatedAt", "path"];

/// Applies a change to the campaign's name, system and/or settings and
/// persists it. `extra`, when given, replaces the settings wholesale.
pub fn update(
    root: &Path,
    current: &CampaignMeta,
    name: Option<&str>,
    system: Option<Option<&str>>,
    extra: Option<Extra>,
) -> Result<CampaignMeta, StorageError> {
    let mut meta = current.clone();
    if let Some(name) = name {
        let name = name.trim();
        if name.is_empty() {
            return Err(StorageError::InvalidInput("campaign name is empty".into()));
        }
        meta.name = name.to_owned();
    }
    if let Some(system) = system {
        meta.system = system
            .map(|s| s.trim().to_owned())
            .filter(|s| !s.is_empty());
    }
    if let Some(mut extra) = extra {
        for key in RESERVED_KEYS {
            extra.remove(key);
        }
        meta.extra = extra;
    }
    meta.updated_at = now_rfc3339();
    write_meta(root, &meta)?;
    Ok(meta)
}

pub fn open(root: &Path) -> Result<CampaignMeta, StorageError> {
    let file = root.join(CAMPAIGN_FILE);
    if !file.is_file() {
        return Err(StorageError::NotACampaign(root.to_path_buf()));
    }
    let text = fs::read_to_string(&file).map_err(|e| StorageError::io(&file, e))?;
    let mut meta: CampaignMeta = serde_json::from_str(&text)?;
    meta.path = root.to_string_lossy().into_owned();
    // Older campaigns may predate the elements dir; make sure it exists.
    fs::create_dir_all(root.join(ELEMENTS_DIR)).map_err(|e| StorageError::io(root, e))?;
    Ok(meta)
}

fn write_meta(root: &Path, meta: &CampaignMeta) -> Result<(), StorageError> {
    // `path` is runtime-only and skipped when empty; clear it before persisting.
    let mut persisted = meta.clone();
    persisted.path = String::new();
    let file = root.join(CAMPAIGN_FILE);
    let text = serde_json::to_string_pretty(&persisted)?;
    fs::write(&file, text + "\n").map_err(|e| StorageError::io(&file, e))
}
