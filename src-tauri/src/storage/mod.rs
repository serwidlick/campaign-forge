//! Plain-file storage for a campaign.
//!
//! Layout on disk:
//!
//! ```text
//! <campaign root>/
//!   campaign.json              campaign metadata
//!   elements/<kind>/<slug>.md  one Markdown file per world-bible element,
//!                              YAML frontmatter + body
//! ```
//!
//! The files are the source of truth. The in-memory index maps element IDs to
//! paths so lookups do not need a directory walk on every call; it is rebuilt
//! whenever a campaign is opened and kept in sync by the mutating methods.

mod campaign;
mod elements;
mod error;
mod frontmatter;
mod model;
mod slug;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard};

pub use error::StorageError;
pub use model::{CampaignMeta, Element, ElementMeta, SaveElementInput};

/// The currently open campaign, if any.
struct OpenCampaign {
    root: PathBuf,
    meta: CampaignMeta,
    /// element id -> absolute path of its Markdown file
    index: HashMap<String, PathBuf>,
}

/// Tauri-managed application state.
#[derive(Default)]
pub struct AppState {
    inner: Mutex<Option<OpenCampaign>>,
}

impl AppState {
    pub fn current_campaign(&self) -> Option<CampaignMeta> {
        self.inner
            .lock()
            .ok()
            .and_then(|guard| guard.as_ref().map(|c| c.meta.clone()))
    }

    pub fn create_campaign(
        &self,
        path: String,
        name: String,
        system: Option<String>,
    ) -> Result<CampaignMeta, StorageError> {
        let root = PathBuf::from(path);
        let meta = campaign::create(&root, &name, system.as_deref())?;
        self.set_open(root, meta.clone())?;
        Ok(meta)
    }

    pub fn open_campaign(&self, path: String) -> Result<CampaignMeta, StorageError> {
        let root = PathBuf::from(path);
        let meta = campaign::open(&root)?;
        self.set_open(root, meta.clone())?;
        Ok(meta)
    }

    pub fn list_elements(&self) -> Result<Vec<ElementMeta>, StorageError> {
        let mut guard = self.lock()?;
        let open = guard.as_mut().ok_or(StorageError::NoCampaignOpen)?;
        let (metas, index) = elements::scan(&open.root)?;
        open.index = index;
        Ok(metas)
    }

    pub fn read_element(&self, id: &str) -> Result<Element, StorageError> {
        let guard = self.lock()?;
        let open = guard.as_ref().ok_or(StorageError::NoCampaignOpen)?;
        let path = open
            .index
            .get(id)
            .ok_or_else(|| StorageError::ElementNotFound(id.to_owned()))?;
        elements::read(&open.root, path)
    }

    pub fn create_element(&self, kind: &str, name: &str) -> Result<Element, StorageError> {
        let mut guard = self.lock()?;
        let open = guard.as_mut().ok_or(StorageError::NoCampaignOpen)?;
        let element = elements::create(&open.root, kind, name)?;
        open.index
            .insert(element.meta.id.clone(), open.root.join(&element.meta.path));
        Ok(element)
    }

    pub fn save_element(&self, input: SaveElementInput) -> Result<Element, StorageError> {
        let guard = self.lock()?;
        let open = guard.as_ref().ok_or(StorageError::NoCampaignOpen)?;
        let path = open
            .index
            .get(&input.id)
            .ok_or_else(|| StorageError::ElementNotFound(input.id.clone()))?;
        elements::save(&open.root, path, input)
    }

    pub fn delete_element(&self, id: &str) -> Result<(), StorageError> {
        let mut guard = self.lock()?;
        let open = guard.as_mut().ok_or(StorageError::NoCampaignOpen)?;
        let path = open
            .index
            .remove(id)
            .ok_or_else(|| StorageError::ElementNotFound(id.to_owned()))?;
        elements::delete(&path)
    }

    fn set_open(&self, root: PathBuf, meta: CampaignMeta) -> Result<(), StorageError> {
        let (_, index) = elements::scan(&root)?;
        let mut guard = self.lock()?;
        *guard = Some(OpenCampaign { root, meta, index });
        Ok(())
    }

    fn lock(&self) -> Result<MutexGuard<'_, Option<OpenCampaign>>, StorageError> {
        self.inner.lock().map_err(|_| StorageError::Poisoned)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A unique temp folder that is removed when dropped.
    struct TempRoot(PathBuf);

    impl TempRoot {
        fn new(tag: &str) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "campaign-forge-test-{tag}-{}",
                uuid::Uuid::new_v4()
            ));
            std::fs::create_dir_all(&dir).unwrap();
            TempRoot(dir)
        }

        fn path(&self) -> String {
            self.0.to_string_lossy().into_owned()
        }
    }

    impl Drop for TempRoot {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn full_round_trip_through_app_state() {
        let root = TempRoot::new("roundtrip");
        let state = AppState::default();

        // Nothing open yet.
        assert!(state.current_campaign().is_none());
        assert!(matches!(
            state.list_elements(),
            Err(StorageError::NoCampaignOpen)
        ));

        // Create a campaign and an element.
        let meta = state
            .create_campaign(
                root.path(),
                "  Test Campaign ".into(),
                Some("D&D 5e".into()),
            )
            .unwrap();
        assert_eq!(meta.name, "Test Campaign");
        assert_eq!(meta.system.as_deref(), Some("D&D 5e"));
        assert!(root.0.join("campaign.json").is_file());

        let created = state
            .create_element("Location", "The Rusty Tankard")
            .unwrap();
        assert_eq!(created.meta.kind, "location");
        assert_eq!(created.meta.path, "elements/location/the-rusty-tankard.md");
        assert_eq!(created.body, "# The Rusty Tankard\n");
        assert!(root.0.join(&created.meta.path).is_file());

        // Same name again gets a distinct file but a distinct id.
        let twin = state
            .create_element("location", "The Rusty Tankard")
            .unwrap();
        assert_ne!(twin.meta.id, created.meta.id);
        assert_eq!(twin.meta.path, "elements/location/the-rusty-tankard-2.md");

        // Save with new body and tags, then read it back from disk.
        let saved = state
            .save_element(SaveElementInput {
                id: created.meta.id.clone(),
                name: "The Rusty Tankard (renamed)".into(),
                tags: vec!["tavern".into(), " ".into(), "waterdeep".into()],
                body: "# Renamed\n\nA **dockside** tavern.\n".into(),
            })
            .unwrap();
        assert_eq!(saved.meta.tags, vec!["tavern", "waterdeep"]);

        let read = state.read_element(&created.meta.id).unwrap();
        assert_eq!(read.meta.name, "The Rusty Tankard (renamed)");
        assert_eq!(read.body.trim(), "# Renamed\n\nA **dockside** tavern.");
        // File name is stable across renames; linking is by id.
        assert_eq!(read.meta.path, created.meta.path);

        // Listing sees both, sorted by kind then name.
        let listed = state.list_elements().unwrap();
        assert_eq!(listed.len(), 2);

        // Re-open from disk with a fresh state and confirm the index rebuilds.
        let fresh = AppState::default();
        let reopened = fresh.open_campaign(root.path()).unwrap();
        assert_eq!(reopened.id, meta.id);
        assert_eq!(fresh.list_elements().unwrap().len(), 2);
        assert!(fresh.read_element(&twin.meta.id).is_ok());

        // Delete and confirm it is gone from disk and from the index.
        fresh.delete_element(&twin.meta.id).unwrap();
        assert!(!root.0.join(&twin.meta.path).exists());
        assert!(matches!(
            fresh.read_element(&twin.meta.id),
            Err(StorageError::ElementNotFound(_))
        ));
        assert_eq!(fresh.list_elements().unwrap().len(), 1);
    }

    #[test]
    fn create_refuses_existing_campaign_and_open_refuses_plain_folder() {
        let root = TempRoot::new("guards");
        let state = AppState::default();

        assert!(matches!(
            state.open_campaign(root.path()),
            Err(StorageError::NotACampaign(_))
        ));

        state
            .create_campaign(root.path(), "One".into(), None)
            .unwrap();
        assert!(matches!(
            AppState::default().create_campaign(root.path(), "Two".into(), None),
            Err(StorageError::AlreadyACampaign(_))
        ));
    }

    #[test]
    fn scan_skips_stray_markdown_without_frontmatter() {
        let root = TempRoot::new("stray");
        let state = AppState::default();
        state
            .create_campaign(root.path(), "Stray".into(), None)
            .unwrap();
        state.create_element("lore", "Real").unwrap();

        let stray_dir = root.0.join("elements").join("lore");
        std::fs::write(stray_dir.join("notes.md"), "# just notes\n").unwrap();

        let listed = state.list_elements().unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].name, "Real");
    }
}
