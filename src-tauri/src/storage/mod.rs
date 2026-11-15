//! Plain-file storage for a campaign.
//!
//! Layout on disk:
//!
//! ```text
//! <campaign root>/
//!   campaign.json              campaign metadata
//!   elements/<kind>/<slug>.md  one Markdown file per world-bible element,
//!                              YAML frontmatter + body
//!   conversations/<id>.json    saved assistant conversations (GM-only)
//! ```
//!
//! The files are the source of truth. The in-memory index maps element IDs to
//! paths so lookups do not need a directory walk on every call; it is rebuilt
//! whenever a campaign is opened and kept in sync by the mutating methods.

mod assets;
mod campaign;
mod conversations;
mod elements;
mod error;
mod frontmatter;
mod links;
mod model;
mod search;
mod slug;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

use tokio::sync::watch;

pub use assets::{ImportedDocument, ImportedImage, MAX_DOCUMENT_BYTES, MAX_IMAGE_BYTES};
pub use conversations::{Conversation, ConversationSummary};
pub use error::StorageError;
pub use links::extract_links;
pub use model::{CampaignMeta, Element, ElementSummary, Extra, SaveElementInput};
pub use search::SearchHit;

/// Whether `path` still holds a campaign (its `campaign.json` is present).
/// Needs no open campaign and touches nothing on disk.
pub fn campaign_exists(path: &str) -> bool {
    campaign::exists(Path::new(path))
}

/// The currently open campaign, if any.
struct OpenCampaign {
    root: PathBuf,
    meta: CampaignMeta,
    /// element id -> absolute path of its Markdown file
    index: HashMap<String, PathBuf>,
    /// Element file -> version this process last wrote or already reported.
    /// The folder watcher uses it to tell the app's own writes apart from
    /// edits made elsewhere (a sync client, another program).
    seen: HashMap<PathBuf, String>,
}

/// What [`AppState::apply_disk_changes`] found in a batch of changed paths.
#[derive(Debug, Clone, Default, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiskChanges {
    /// Elements whose file changed (or appeared) outside this window.
    pub element_ids: Vec<String>,
    /// Elements were added, removed or moved: the list needs a rescan.
    pub list_changed: bool,
    /// `campaign.json` changed outside this window.
    pub campaign_changed: bool,
}

impl DiskChanges {
    pub fn is_empty(&self) -> bool {
        self.element_ids.is_empty() && !self.list_changed && !self.campaign_changed
    }
}

/// Tauri-managed application state.
pub struct AppState {
    inner: Mutex<Option<OpenCampaign>>,
    /// Bumped after every write so long-lived readers (the table server) can
    /// wait for "something changed" instead of polling the disk.
    changes: watch::Sender<u64>,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            inner: Mutex::new(None),
            changes: watch::channel(0).0,
        }
    }
}

impl AppState {
    /// Current change counter. Monotonic for the life of the process.
    pub fn version(&self) -> u64 {
        *self.changes.borrow()
    }

    /// A receiver that wakes whenever the counter is bumped.
    pub fn changes(&self) -> watch::Receiver<u64> {
        self.changes.subscribe()
    }

    fn bump(&self) {
        self.changes.send_modify(|v| *v += 1);
    }

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

    /// Changes the campaign's name, system and/or settings. Each argument is
    /// optional; `system: Some(None)` clears the system.
    pub fn update_campaign(
        &self,
        name: Option<String>,
        system: Option<Option<String>>,
        extra: Option<Extra>,
    ) -> Result<CampaignMeta, StorageError> {
        let mut guard = self.lock()?;
        let open = guard.as_mut().ok_or(StorageError::NoCampaignOpen)?;
        let meta = campaign::update(
            &open.root,
            &open.meta,
            name.as_deref(),
            system.as_ref().map(|s| s.as_deref()),
            extra,
        )?;
        open.meta = meta.clone();
        drop(guard);
        self.bump();
        Ok(meta)
    }

    pub fn list_elements(&self) -> Result<Vec<ElementSummary>, StorageError> {
        let mut guard = self.lock()?;
        let open = guard.as_mut().ok_or(StorageError::NoCampaignOpen)?;
        let (summaries, index) = elements::scan(&open.root)?;
        open.index = index;
        Ok(summaries)
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

    pub fn create_element(
        &self,
        kind: &str,
        name: &str,
        extra: Option<Extra>,
    ) -> Result<Element, StorageError> {
        let mut guard = self.lock()?;
        let open = guard.as_mut().ok_or(StorageError::NoCampaignOpen)?;
        let element = elements::create(&open.root, kind, name, extra)?;
        let path = open.root.join(&element.meta.path);
        open.seen.insert(path.clone(), element.version.clone());
        open.index.insert(element.meta.id.clone(), path);
        drop(guard);
        self.bump();
        Ok(element)
    }

    /// A save made by the GM's window, which already shows the result.
    pub fn save_element(&self, input: SaveElementInput) -> Result<Element, StorageError> {
        self.save_element_inner(input, true)
    }

    /// A save the GM's window did not make (a player editing their sheet at
    /// the table). It is left out of `seen`, so the folder watcher reports it
    /// to the window exactly like an edit from another program.
    pub fn save_element_unseen(&self, input: SaveElementInput) -> Result<Element, StorageError> {
        self.save_element_inner(input, false)
    }

    fn save_element_inner(
        &self,
        input: SaveElementInput,
        record: bool,
    ) -> Result<Element, StorageError> {
        let mut guard = self.lock()?;
        let open = guard.as_mut().ok_or(StorageError::NoCampaignOpen)?;
        let path = open
            .index
            .get(&input.id)
            .ok_or_else(|| StorageError::ElementNotFound(input.id.clone()))?
            .clone();
        let saved = elements::save(&open.root, &path, input)?;
        if record {
            open.seen.insert(path, saved.version.clone());
        }
        drop(guard);
        self.bump();
        Ok(saved)
    }

    pub fn delete_element(&self, id: &str) -> Result<(), StorageError> {
        let mut guard = self.lock()?;
        let open = guard.as_mut().ok_or(StorageError::NoCampaignOpen)?;
        let path = open
            .index
            .remove(id)
            .ok_or_else(|| StorageError::ElementNotFound(id.to_owned()))?;
        open.seen.remove(&path);
        elements::delete(&path)?;
        drop(guard);
        self.bump();
        Ok(())
    }

    /// Copies an image file into the campaign's assets folder for the given
    /// map element and returns its relative path and size.
    pub fn import_map_image(
        &self,
        map_id: &str,
        source: &str,
    ) -> Result<ImportedImage, StorageError> {
        let guard = self.lock()?;
        let open = guard.as_ref().ok_or(StorageError::NoCampaignOpen)?;
        let stem = map_stem(&open.index, map_id);
        let imported =
            assets::import_image(&open.root, "maps", stem, std::path::Path::new(source))?;
        drop(guard);
        self.bump();
        Ok(imported)
    }

    /// Same as [`Self::import_map_image`] but from bytes already in memory
    /// (drag and drop from a browser, a download).
    pub fn import_map_image_bytes(
        &self,
        map_id: &str,
        bytes: &[u8],
    ) -> Result<ImportedImage, StorageError> {
        let guard = self.lock()?;
        let open = guard.as_ref().ok_or(StorageError::NoCampaignOpen)?;
        let stem = map_stem(&open.index, map_id);
        let imported = assets::import_image_bytes(&open.root, "maps", stem, bytes)?;
        drop(guard);
        self.bump();
        Ok(imported)
    }

    /// Copies a picture for any element into `assets/images/`. The caller
    /// stores the returned path in the element's `portrait` field.
    pub fn import_element_image(
        &self,
        element_id: &str,
        source: &str,
    ) -> Result<ImportedImage, StorageError> {
        let guard = self.lock()?;
        let open = guard.as_ref().ok_or(StorageError::NoCampaignOpen)?;
        let stem = map_stem(&open.index, element_id);
        let imported =
            assets::import_image(&open.root, "images", stem, std::path::Path::new(source))?;
        drop(guard);
        self.bump();
        Ok(imported)
    }

    pub fn import_element_image_bytes(
        &self,
        element_id: &str,
        bytes: &[u8],
    ) -> Result<ImportedImage, StorageError> {
        let guard = self.lock()?;
        let open = guard.as_ref().ok_or(StorageError::NoCampaignOpen)?;
        let stem = map_stem(&open.index, element_id);
        let imported = assets::import_image_bytes(&open.root, "images", stem, bytes)?;
        drop(guard);
        self.bump();
        Ok(imported)
    }

    /// Copies a PDF into `assets/docs/`. The caller stores the returned path
    /// in a Document element's `file` field.
    pub fn import_document(&self, source: &str) -> Result<ImportedDocument, StorageError> {
        let guard = self.lock()?;
        let open = guard.as_ref().ok_or(StorageError::NoCampaignOpen)?;
        let imported = assets::import_document(&open.root, "docs", std::path::Path::new(source))?;
        drop(guard);
        self.bump();
        Ok(imported)
    }

    /// Case-insensitive text search over names, tags and bodies.
    pub fn search_elements(
        &self,
        query: &str,
        limit: usize,
    ) -> Result<Vec<SearchHit>, StorageError> {
        let guard = self.lock()?;
        let open = guard.as_ref().ok_or(StorageError::NoCampaignOpen)?;
        search::search(&open.root, &open.index, query, limit)
    }

    // Conversations do not bump the change counter: they are GM-only, so no
    // player view needs to wake up for them.

    pub fn list_conversations(&self) -> Result<Vec<ConversationSummary>, StorageError> {
        conversations::list(&self.root()?)
    }

    pub fn read_conversation(&self, id: &str) -> Result<Conversation, StorageError> {
        conversations::read(&self.root()?, id)
    }

    pub fn save_conversation(
        &self,
        conversation: Conversation,
    ) -> Result<ConversationSummary, StorageError> {
        conversations::save(&self.root()?, conversation)
    }

    pub fn delete_conversation(&self, id: &str) -> Result<(), StorageError> {
        conversations::delete(&self.root()?, id)
    }

    pub fn read_asset(&self, rel: &str) -> Result<Vec<u8>, StorageError> {
        let guard = self.lock()?;
        let open = guard.as_ref().ok_or(StorageError::NoCampaignOpen)?;
        assets::read(&open.root, rel)
    }

    fn set_open(&self, root: PathBuf, meta: CampaignMeta) -> Result<(), StorageError> {
        let (_, index) = elements::scan(&root)?;
        let mut guard = self.lock()?;
        *guard = Some(OpenCampaign {
            root,
            meta,
            index,
            seen: HashMap::new(),
        });
        drop(guard);
        self.bump();
        Ok(())
    }

    /// Takes a batch of paths the folder watcher saw change and works out
    /// which of them are edits made outside this window. The app's own writes
    /// are recognised by version and skipped. Updates the id index and the
    /// campaign metadata to match the disk, and bumps the change counter so
    /// players at the table see the new content too.
    pub fn apply_disk_changes(&self, paths: &[PathBuf]) -> Result<DiskChanges, StorageError> {
        let mut guard = self.lock()?;
        let Some(open) = guard.as_mut() else {
            return Ok(DiskChanges::default());
        };
        let mut changes = DiskChanges::default();
        let elements_dir = open.root.join(campaign::ELEMENTS_DIR);

        for path in paths {
            if path == &open.root.join(campaign::CAMPAIGN_FILE) {
                // A half-synced or hand-broken file is ignored until it parses.
                if let Ok(meta) = campaign::open(&open.root)
                    && serde_json::to_value(&meta).ok() != serde_json::to_value(&open.meta).ok()
                {
                    open.meta = meta;
                    changes.campaign_changed = true;
                }
                continue;
            }
            let is_element = path.starts_with(&elements_dir)
                && path.extension().and_then(|e| e.to_str()) == Some("md");
            if !is_element {
                continue;
            }
            if !path.is_file() {
                // Gone. Only matters if it was an element we knew about; our
                // own deletes already dropped it from the index.
                let before = open.index.len();
                open.index.retain(|_, p| p != path);
                open.seen.remove(path);
                if open.index.len() != before {
                    changes.list_changed = true;
                }
                continue;
            }
            let element = match elements::read(&open.root, path) {
                Ok(e) => e,
                // Partly synced, or a stray note without frontmatter.
                Err(StorageError::InvalidFrontmatter { .. }) => continue,
                Err(StorageError::Io { .. }) => continue,
                Err(other) => return Err(other),
            };
            if open.seen.get(path) == Some(&element.version) {
                continue;
            }
            open.seen.insert(path.clone(), element.version.clone());
            let id = element.meta.id;
            match open.index.get(&id) {
                Some(known) if known == path => {}
                // The id already lives in another file that still exists (a
                // sync client's conflict copy): keep the original for now.
                Some(known) if known.is_file() => {
                    changes.list_changed = true;
                    continue;
                }
                _ => {
                    open.index.insert(id.clone(), path.clone());
                    changes.list_changed = true;
                }
            }
            if !changes.element_ids.contains(&id) {
                changes.element_ids.push(id);
            }
        }
        drop(guard);
        if !changes.is_empty() {
            self.bump();
        }
        Ok(changes)
    }

    /// The open campaign's folder, without holding the lock during file IO.
    fn root(&self) -> Result<PathBuf, StorageError> {
        let guard = self.lock()?;
        let open = guard.as_ref().ok_or(StorageError::NoCampaignOpen)?;
        Ok(open.root.clone())
    }

    fn lock(&self) -> Result<MutexGuard<'_, Option<OpenCampaign>>, StorageError> {
        self.inner.lock().map_err(|_| StorageError::Poisoned)
    }
}

/// File stem for assets belonging to an element: its Markdown file's stem,
/// or "map" when the element is unknown.
fn map_stem<'a>(index: &'a HashMap<String, PathBuf>, id: &str) -> &'a str {
    index
        .get(id)
        .and_then(|p| p.file_stem())
        .and_then(|s| s.to_str())
        .unwrap_or("map")
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
            .create_element("Location", "The Rusty Tankard", None)
            .unwrap();
        assert_eq!(created.meta.kind, "location");
        assert_eq!(created.meta.path, "elements/location/the-rusty-tankard.md");
        assert_eq!(created.body, "# The Rusty Tankard\n");
        assert!(root.0.join(&created.meta.path).is_file());

        // Same name again gets a distinct file but a distinct id.
        let twin = state
            .create_element("location", "The Rusty Tankard", None)
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
                extra: None,
                base_version: None,
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
    fn extra_fields_round_trip_and_reserved_keys_are_stripped() {
        let root = TempRoot::new("extra");
        let state = AppState::default();
        state
            .create_campaign(root.path(), "Extra".into(), None)
            .unwrap();

        let initial: Extra = serde_json::from_str(
            r#"{"arc":"arc-1","number":3,"status":"planned","name":"EVIL","type":"EVIL"}"#,
        )
        .unwrap();
        let created = state
            .create_element("session", "Session 3", Some(initial))
            .unwrap();
        assert_eq!(created.meta.name, "Session 3");
        assert_eq!(created.meta.kind, "session");
        assert_eq!(created.meta.extra["arc"], "arc-1");
        assert_eq!(created.meta.extra["number"], 3);
        assert!(!created.meta.extra.contains_key("name"));
        assert!(!created.meta.extra.contains_key("type"));

        // Save without `extra` keeps the fields; save with `extra` replaces them.
        let kept = state
            .save_element(SaveElementInput {
                id: created.meta.id.clone(),
                name: "Session 3".into(),
                tags: vec![],
                body: "notes".into(),
                extra: None,
                base_version: None,
            })
            .unwrap();
        assert_eq!(kept.meta.extra["status"], "planned");

        let replaced: Extra = serde_json::from_str(
            r#"{"arc":"arc-1","number":3,"status":"played","beats":[{"id":"b1","title":"Arrive","role":"beat","done":true,"notes":""}]}"#,
        )
        .unwrap();
        state
            .save_element(SaveElementInput {
                id: created.meta.id.clone(),
                name: "Session 3".into(),
                tags: vec![],
                body: "notes".into(),
                extra: Some(replaced),
                base_version: None,
            })
            .unwrap();

        // Reopen from disk: structured fields survive the YAML round trip.
        let fresh = AppState::default();
        fresh.open_campaign(root.path()).unwrap();
        let read = fresh.read_element(&created.meta.id).unwrap();
        assert_eq!(read.meta.extra["status"], "played");
        assert_eq!(read.meta.extra["beats"][0]["title"], "Arrive");
        assert_eq!(read.meta.extra["beats"][0]["done"], true);
        assert_eq!(read.meta.extra["number"], 3);
        let listed = fresh.list_elements().unwrap();
        assert_eq!(listed[0].meta.extra["arc"], "arc-1");
    }

    #[test]
    fn campaign_settings_round_trip() {
        let root = TempRoot::new("settings");
        let state = AppState::default();
        state
            .create_campaign(root.path(), "Settings".into(), None)
            .unwrap();

        let extra: Extra = serde_json::from_str(
            r#"{"calendar":{"name":"Harptos","months":[{"name":"Hammer","days":30}]},"name":"EVIL"}"#,
        )
        .unwrap();
        let updated = state
            .update_campaign(None, Some(Some("Daggerheart".into())), Some(extra))
            .unwrap();
        assert_eq!(updated.name, "Settings");
        assert_eq!(updated.system.as_deref(), Some("Daggerheart"));
        assert_eq!(updated.extra["calendar"]["name"], "Harptos");
        assert!(!updated.extra.contains_key("name"));

        let fresh = AppState::default();
        let reopened = fresh.open_campaign(root.path()).unwrap();
        assert_eq!(reopened.extra["calendar"]["months"][0]["days"], 30);
        assert_eq!(reopened.system.as_deref(), Some("Daggerheart"));

        // Clearing the system.
        let cleared = fresh.update_campaign(None, Some(None), None).unwrap();
        assert!(cleared.system.is_none());
        assert_eq!(cleared.extra["calendar"]["name"], "Harptos");
    }

    #[test]
    fn scan_skips_stray_markdown_without_frontmatter() {
        let root = TempRoot::new("stray");
        let state = AppState::default();
        state
            .create_campaign(root.path(), "Stray".into(), None)
            .unwrap();
        state.create_element("lore", "Real", None).unwrap();

        let stray_dir = root.0.join("elements").join("lore");
        std::fs::write(stray_dir.join("notes.md"), "# just notes\n").unwrap();

        let listed = state.list_elements().unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].meta.name, "Real");
    }

    fn save_input(element: &Element, body: &str, base: Option<&str>) -> SaveElementInput {
        SaveElementInput {
            id: element.meta.id.clone(),
            name: element.meta.name.clone(),
            tags: vec![],
            body: body.into(),
            extra: None,
            base_version: base.map(str::to_owned),
        }
    }

    #[test]
    fn save_refuses_when_file_changed_since_it_was_loaded() {
        let root = TempRoot::new("conflict");
        let state = AppState::default();
        state
            .create_campaign(root.path(), "Conflict".into(), None)
            .unwrap();
        let created = state.create_element("npc", "Mira", None).unwrap();

        // Saving on top of the version we hold works and moves the version on.
        let first = state
            .save_element(save_input(&created, "one", Some(&created.version)))
            .unwrap();
        assert_ne!(first.version, created.version);
        assert_eq!(
            state.read_element(&created.meta.id).unwrap().version,
            first.version
        );

        // Another device rewrites the file behind our back.
        let file = root.0.join(&created.meta.path);
        let text = std::fs::read_to_string(&file).unwrap();
        std::fs::write(&file, text.replace("one", "theirs")).unwrap();

        assert!(matches!(
            state.save_element(save_input(&created, "mine", Some(&first.version))),
            Err(StorageError::Conflict(_))
        ));
        assert!(std::fs::read_to_string(&file).unwrap().contains("theirs"));

        // No base version means "overwrite", which is what "keep mine" does.
        state
            .save_element(save_input(&created, "mine", None))
            .unwrap();
        assert!(std::fs::read_to_string(&file).unwrap().contains("mine"));
    }

    #[test]
    fn disk_changes_skip_own_writes_and_report_outside_ones() {
        let root = TempRoot::new("watch");
        let state = AppState::default();
        state
            .create_campaign(root.path(), "Watch".into(), None)
            .unwrap();
        let created = state.create_element("npc", "Mira", None).unwrap();
        let file = root.0.join(&created.meta.path);
        let saved = state
            .save_element(save_input(&created, "ours", Some(&created.version)))
            .unwrap();

        // Our own create and save: nothing to report.
        assert!(
            state
                .apply_disk_changes(std::slice::from_ref(&file))
                .unwrap()
                .is_empty()
        );

        // An outside edit is reported once, then remembered.
        let text = std::fs::read_to_string(&file).unwrap();
        std::fs::write(&file, text.replace("ours", "synced")).unwrap();
        let changes = state
            .apply_disk_changes(std::slice::from_ref(&file))
            .unwrap();
        assert_eq!(changes.element_ids, vec![created.meta.id.clone()]);
        assert!(!changes.list_changed);
        assert!(
            state
                .apply_disk_changes(std::slice::from_ref(&file))
                .unwrap()
                .is_empty()
        );

        // A player's sheet edit at the table is reported to the GM's window.
        let latest = state.read_element(&created.meta.id).unwrap();
        assert_ne!(latest.version, saved.version);
        state
            .save_element_unseen(save_input(&latest, "player", Some(&latest.version)))
            .unwrap();
        let changes = state
            .apply_disk_changes(std::slice::from_ref(&file))
            .unwrap();
        assert_eq!(changes.element_ids, vec![created.meta.id.clone()]);

        // A new file from another device joins the index.
        let other = root.0.join("elements").join("npc").join("bran.md");
        std::fs::write(
            &other,
            "---\nid: bran-1\ntype: npc\nname: Bran\ncreatedAt: x\nupdatedAt: x\n---\n# Bran\n",
        )
        .unwrap();
        let changes = state
            .apply_disk_changes(std::slice::from_ref(&other))
            .unwrap();
        assert!(changes.list_changed);
        assert!(state.read_element("bran-1").is_ok());

        // A conflict copy with the same id does not take over the original.
        let copy = root.0.join("elements").join("npc").join("mira (1).md");
        std::fs::copy(&file, &copy).unwrap();
        state
            .apply_disk_changes(std::slice::from_ref(&copy))
            .unwrap();
        assert_eq!(
            state.read_element(&created.meta.id).unwrap().meta.path,
            created.meta.path
        );
        let listed = state.list_elements().unwrap();
        assert_eq!(listed.len(), 2);
        assert_eq!(
            state.read_element(&created.meta.id).unwrap().meta.path,
            created.meta.path
        );

        // Deleted on another device: dropped from the index.
        std::fs::remove_file(&other).unwrap();
        assert!(state.apply_disk_changes(&[other]).unwrap().list_changed);
        assert!(state.read_element("bran-1").is_err());

        // campaign.json edited elsewhere is picked up; our own update is not.
        state
            .update_campaign(Some("Renamed".into()), None, None)
            .unwrap();
        let meta_file = root.0.join("campaign.json");
        assert!(
            state
                .apply_disk_changes(std::slice::from_ref(&meta_file))
                .unwrap()
                .is_empty()
        );
        let text = std::fs::read_to_string(&meta_file).unwrap();
        std::fs::write(&meta_file, text.replace("Renamed", "Synced")).unwrap();
        assert!(
            state
                .apply_disk_changes(&[meta_file])
                .unwrap()
                .campaign_changed
        );
        assert_eq!(state.current_campaign().unwrap().name, "Synced");
    }
}
