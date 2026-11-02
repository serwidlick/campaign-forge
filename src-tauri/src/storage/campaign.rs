use std::fs;
use std::path::Path;

use super::error::StorageError;
use super::model::{CampaignMeta, new_id, now_rfc3339};

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
    };
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
