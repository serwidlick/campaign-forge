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
//!   .trash/<kind>/<slug>.md    recently deleted elements, kept for 30 days
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
mod trash;

use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

use tokio::sync::watch;

pub use assets::{ImportedDocument, ImportedImage, MAX_DOCUMENT_BYTES, MAX_IMAGE_BYTES};
pub use conversations::{Conversation, ConversationSummary};
pub use error::StorageError;
pub use links::extract_links;
pub use model::{CampaignMeta, Element, ElementSummary, Extra, SaveElementInput};
pub use search::SearchHit;
pub use trash::TrashedElement;

/// Whether `path` still holds a campaign (its `campaign.json` is present).
/// Needs no open campaign and touches nothing on disk.
pub fn campaign_exists(path: &str) -> bool {
    campaign::exists(Path::new(path))
}

/// The currently open campaign, if any.
struct OpenCampaign {
    devices: crate::table::players::DeviceRegistry,
    table_index: HashMap<String, TableEntry>,
    root: PathBuf,
    meta: CampaignMeta,
    /// element id -> absolute path of its Markdown file
    index: HashMap<String, PathBuf>,
    /// Element file -> version this process last wrote or already reported.
    /// The folder watcher uses it to tell the app's own writes apart from
    /// edits made elsewhere (a sync client, another program).
    seen: HashMap<PathBuf, String>,
}

/// Derived in memory alongside the path index. Markdown files remain authoritative.
#[derive(Debug, Clone)]
pub struct TableEntry {
    pub summary: ElementSummary,
    pub player_links: Vec<String>,
    pub version: String,
}

impl From<&Element> for TableEntry {
    fn from(element: &Element) -> Self {
        let player_links =
            if !element.links.is_empty() && crate::table::share::is_shared(&element.meta.extra) {
                extract_links(&crate::table::share::player_body(&element.body).0)
            } else {
                Vec::new()
            };
        Self {
            summary: element.summary(),
            player_links,
            version: element.version.clone(),
        }
    }
}

/// What changed in the campaign, as a window that did not make the change
/// needs to hear it: what [`AppState::apply_disk_changes`] found in a batch
/// of changed paths, and what each bump of the change counter was about.
#[derive(Debug, Clone, Default, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct DiskChanges {
    /// Elements whose file changed (or appeared) outside this window.
    pub element_ids: Vec<String>,
    /// Elements were added, removed or moved: the list needs a rescan.
    pub list_changed: bool,
    /// `campaign.json` changed outside this window.
    pub campaign_changed: bool,
    /// The file version each changed element now has, by id. A reader that
    /// already shows that version (it made the change) can skip the reload.
    #[serde(skip_serializing_if = "HashMap::is_empty")]
    pub versions: HashMap<String, String>,
}

impl DiskChanges {
    pub fn is_empty(&self) -> bool {
        self.element_ids.is_empty() && !self.list_changed && !self.campaign_changed
    }

    pub fn element(id: &str, version: &str) -> Self {
        DiskChanges {
            element_ids: vec![id.to_owned()],
            versions: HashMap::from([(id.to_owned(), version.to_owned())]),
            ..Default::default()
        }
    }

    pub fn list() -> Self {
        DiskChanges {
            list_changed: true,
            ..Default::default()
        }
    }

    pub fn campaign() -> Self {
        DiskChanges {
            campaign_changed: true,
            ..Default::default()
        }
    }

    /// Everything may have changed: rescan the list and re-read the metadata.
    pub fn everything() -> Self {
        DiskChanges {
            list_changed: true,
            campaign_changed: true,
            ..Default::default()
        }
    }

    pub fn merge(&mut self, other: &DiskChanges) {
        for id in &other.element_ids {
            if !self.element_ids.contains(id) {
                self.element_ids.push(id.clone());
            }
        }
        for (id, version) in &other.versions {
            self.versions.insert(id.clone(), version.clone());
        }
        self.list_changed |= other.list_changed;
        self.campaign_changed |= other.campaign_changed;
    }
}

/// How many change notes are kept for readers catching up by version.
const CHANGE_LOG_LEN: usize = 512;

/// Tauri-managed application state.
pub struct AppState {
    inner: Mutex<Option<OpenCampaign>>,
    /// Bumped after every write so long-lived readers (the table server) can
    /// wait for "something changed" instead of polling the disk.
    changes: watch::Sender<u64>,
    /// What each recent bump was about, oldest first, so a GM working from
    /// another machine can ask "what changed since version N".
    log: Mutex<VecDeque<(u64, DiskChanges)>>,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            inner: Mutex::new(None),
            changes: watch::channel(0).0,
            log: Mutex::new(VecDeque::new()),
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

    /// A change nobody's window needs to be told about (an asset import).
    fn bump(&self) {
        self.bump_with(DiskChanges::default());
    }

    /// Bumps the counter and remembers what the bump was about.
    fn bump_with(&self, note: DiskChanges) {
        self.changes.send_modify(|v| {
            *v += 1;
            if let Ok(mut log) = self.log.lock() {
                log.push_back((*v, note));
                while log.len() > CHANGE_LOG_LEN {
                    log.pop_front();
                }
            }
        });
    }

    /// Everything that changed after version `after`, merged. When the log
    /// no longer reaches back that far, the caller is told to rescan.
    pub fn changes_since(&self, after: u64) -> DiskChanges {
        let Ok(log) = self.log.lock() else {
            return DiskChanges::everything();
        };
        let mut out = DiskChanges::default();
        if let Some((oldest, _)) = log.front()
            && *oldest > after + 1
        {
            out = DiskChanges::everything();
        }
        for (_, note) in log.iter().filter(|(v, _)| *v > after) {
            out.merge(note);
        }
        out
    }

    pub(crate) fn paired_identity(&self, fingerprint: &str, id: &str) -> Option<(String, bool)> {
        self.inner
            .lock()
            .ok()?
            .as_ref()?
            .devices
            .identity(fingerprint, id)
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
        open.devices = crate::table::players::DeviceRegistry::from_meta(&meta);
        open.meta = meta.clone();
        drop(guard);
        self.bump_with(DiskChanges::campaign());
        Ok(meta)
    }

    pub fn list_elements(&self) -> Result<Vec<ElementSummary>, StorageError> {
        self.scan_elements(true)
    }

    pub(crate) fn refresh_table(&self) -> Result<(), StorageError> {
        self.scan_elements(false).map(|_| ())
    }

    fn scan_elements(&self, return_summaries: bool) -> Result<Vec<ElementSummary>, StorageError> {
        let mut guard = self.lock()?;
        let open = guard.as_mut().ok_or(StorageError::NoCampaignOpen)?;
        let (entries, index) = elements::scan(&open.root)?;
        let changed = open.index != index
            || entries.iter().any(|entry| {
                open.table_index
                    .get(&entry.summary.meta.id)
                    .is_none_or(|old| old.version != entry.version)
            });
        let mut summaries = Vec::new();
        open.index = index;
        open.table_index.clear();
        for entry in entries {
            if return_summaries {
                summaries.push(entry.summary.clone());
            }
            open.table_index
                .insert(entry.summary.meta.id.clone(), entry);
        }
        drop(guard);
        if changed {
            self.bump_with(DiskChanges::list());
        }
        Ok(summaries)
    }

    pub fn table_entries(&self) -> Result<Vec<TableEntry>, StorageError> {
        let guard = self.lock()?;
        let open = guard.as_ref().ok_or(StorageError::NoCampaignOpen)?;
        Ok(open.table_index.values().cloned().collect())
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
        open.table_index
            .insert(element.meta.id.clone(), TableEntry::from(&element));
        drop(guard);
        let mut note = DiskChanges::element(&element.meta.id, &element.version);
        note.list_changed = true;
        self.bump_with(note);
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
        open.table_index
            .insert(saved.meta.id.clone(), TableEntry::from(&saved));
        if record {
            open.seen.insert(path, saved.version.clone());
        }
        drop(guard);
        self.bump_with(DiskChanges::element(&saved.meta.id, &saved.version));
        Ok(saved)
    }

    /// Changes an element's kind, moving its file to the new kind's folder.
    pub fn change_element_kind(&self, id: &str, kind: &str) -> Result<Element, StorageError> {
        let mut guard = self.lock()?;
        let open = guard.as_mut().ok_or(StorageError::NoCampaignOpen)?;
        let old = open
            .index
            .get(id)
            .ok_or_else(|| StorageError::ElementNotFound(id.to_owned()))?
            .clone();
        let changed = elements::change_kind(&open.root, &old, kind)?;
        let new = open.root.join(&changed.meta.path);
        open.seen.remove(&old);
        open.seen.insert(new.clone(), changed.version.clone());
        open.index.insert(id.to_owned(), new);
        open.table_index
            .insert(changed.meta.id.clone(), TableEntry::from(&changed));
        drop(guard);
        let mut note = DiskChanges::element(&changed.meta.id, &changed.version);
        note.list_changed = true;
        self.bump_with(note);
        Ok(changed)
    }

    /// Moves an element to the trash, where [`Self::restore_element`] can
    /// bring it back for 30 days.
    pub fn delete_element(&self, id: &str) -> Result<(), StorageError> {
        let mut guard = self.lock()?;
        let open = guard.as_mut().ok_or(StorageError::NoCampaignOpen)?;
        let path = open
            .index
            .get(id)
            .cloned()
            .ok_or_else(|| StorageError::ElementNotFound(id.to_owned()))?;
        trash::delete(&open.root, &path)?;
        open.index.remove(id);
        open.seen.remove(&path);
        open.table_index.remove(id);
        drop(guard);
        self.bump_with(DiskChanges::list());
        Ok(())
    }

    /// Deleted elements still in the trash, most recently deleted first.
    pub fn list_trash(&self) -> Result<Vec<TrashedElement>, StorageError> {
        trash::list(&self.root()?)
    }

    /// Brings a deleted element back with its id, frontmatter and body, so
    /// every link to it works again.
    pub fn restore_element(&self, id: &str) -> Result<Element, StorageError> {
        let mut guard = self.lock()?;
        let open = guard.as_mut().ok_or(StorageError::NoCampaignOpen)?;
        if open.index.contains_key(id) {
            return Err(StorageError::InvalidInput(format!(
                "element {id} is not deleted"
            )));
        }
        let restored = trash::restore(&open.root, id)?;
        let path = open.root.join(&restored.meta.path);
        open.seen.insert(path.clone(), restored.version.clone());
        open.index.insert(id.to_owned(), path);
        open.table_index
            .insert(restored.meta.id.clone(), TableEntry::from(&restored));
        drop(guard);
        let mut note = DiskChanges::element(&restored.meta.id, &restored.version);
        note.list_changed = true;
        self.bump_with(note);
        Ok(restored)
    }

    /// Removes a deleted element from the trash for good.
    pub fn purge_element(&self, id: &str) -> Result<(), StorageError> {
        trash::purge(&self.root()?, id)
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

    /// Same as [`Self::import_document`] from bytes already in memory (a PDF
    /// uploaded by a GM working from another machine). `name` is the source
    /// file's name without extension.
    pub fn import_document_bytes(
        &self,
        name: &str,
        bytes: &[u8],
    ) -> Result<ImportedDocument, StorageError> {
        let guard = self.lock()?;
        let open = guard.as_ref().ok_or(StorageError::NoCampaignOpen)?;
        let imported = assets::import_document_bytes(&open.root, "docs", name, bytes)?;
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

    /// Text kept beside a PDF under `assets/docs/` (pages separated by form
    /// feeds), written by an import that read the pages as pictures.
    pub fn read_document_text(&self, pdf_rel: &str) -> Result<Option<String>, StorageError> {
        let guard = self.lock()?;
        let open = guard.as_ref().ok_or(StorageError::NoCampaignOpen)?;
        assets::read_document_text(&open.root, pdf_rel)
    }

    /// Keeps text recovered for a run of a PDF's pages beside it. Not a
    /// change players can see, so the change counter is left alone.
    pub fn save_document_text(
        &self,
        pdf_rel: &str,
        first_page: usize,
        pages: &[String],
        page_count: usize,
    ) -> Result<String, StorageError> {
        let guard = self.lock()?;
        let open = guard.as_ref().ok_or(StorageError::NoCampaignOpen)?;
        assets::write_document_text(&open.root, pdf_rel, first_page, pages, page_count)
    }

    fn set_open(&self, root: PathBuf, meta: CampaignMeta) -> Result<(), StorageError> {
        // Old deletions go for good. A failure here must not stop the open.
        if let Err(err) = trash::prune(&root, chrono::Duration::days(trash::KEEP_DAYS)) {
            eprintln!("trash: could not prune {}: {err}", root.display());
        }
        let (entries, index) = elements::scan(&root)?;
        let mut guard = self.lock()?;
        *guard = Some(OpenCampaign {
            devices: crate::table::players::DeviceRegistry::from_meta(&meta),
            root,
            meta,
            index,
            table_index: entries
                .into_iter()
                .map(|entry| (entry.summary.meta.id.clone(), entry))
                .collect(),
            seen: HashMap::new(),
        });
        drop(guard);
        self.bump_with(DiskChanges::everything());
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
                    open.devices = crate::table::players::DeviceRegistry::from_meta(&meta);
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
            let element = match elements::read(&open.root, path) {
                Ok(element) => element,
                Err(StorageError::Io { source, .. })
                    if source.kind() != std::io::ErrorKind::NotFound =>
                {
                    continue;
                }
                Err(StorageError::InvalidFrontmatter { .. } | StorageError::Io { .. }) => {
                    // A deletion or partial external rewrite must withdraw the old
                    // publication until a valid file can be read at this path.
                    open.index.retain(|id, known| {
                        if known == path {
                            open.table_index.remove(id);
                            changes.list_changed = true;
                            false
                        } else {
                            true
                        }
                    });
                    open.seen.remove(path);
                    continue;
                }
                Err(other) => return Err(other),
            };
            if open.seen.get(path) == Some(&element.version)
                && open
                    .table_index
                    .get(&element.meta.id)
                    .is_some_and(|entry| entry.version == element.version)
            {
                continue;
            }
            open.seen.insert(path.clone(), element.version.clone());
            let id = element.meta.id.clone();
            // Sync tools can replace a file with a different element at the
            // same path. Both the public view and the ID index lose the old ID.
            if open.index.get(&id) != Some(path) {
                open.index.retain(|known_id, known_path| {
                    if known_path == path && known_id != &id {
                        open.table_index.remove(known_id);
                        changes.list_changed = true;
                        false
                    } else {
                        true
                    }
                });
            }
            changes.versions.insert(id.clone(), element.version.clone());
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
            open.table_index
                .insert(id.clone(), TableEntry::from(&element));
            if !changes.element_ids.contains(&id) {
                changes.element_ids.push(id);
            }
        }
        drop(guard);
        if !changes.is_empty() {
            self.bump_with(changes.clone());
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

        // It went to the trash, not away: same id, and the list says where
        // it came from.
        let trashed = fresh.list_trash().unwrap();
        assert_eq!(trashed.len(), 1);
        assert_eq!(trashed[0].summary.meta.id, twin.meta.id);
        assert_eq!(trashed[0].deleted_from, twin.meta.path);
        assert_eq!(
            trashed[0].summary.meta.path,
            ".trash/location/the-rusty-tankard-2.md"
        );
        assert!(root.0.join(&trashed[0].summary.meta.path).is_file());
        assert!(!trashed[0].deleted_at.is_empty());
    }

    #[test]
    fn a_deleted_element_comes_back_whole_and_old_ones_are_pruned() {
        let root = TempRoot::new("trash");
        let state = AppState::default();
        state
            .create_campaign(root.path(), "Trash".into(), None)
            .unwrap();
        let inn = state
            .create_element("location", "The Rusty Tankard", None)
            .unwrap();
        let inn = state
            .save_element(SaveElementInput {
                id: inn.meta.id.clone(),
                name: inn.meta.name.clone(),
                tags: vec!["inn".into()],
                body: "# The Rusty Tankard\n\nA low-beamed inn.\n".into(),
                extra: Some(
                    serde_json::json!({ "shared": true })
                        .as_object()
                        .unwrap()
                        .clone(),
                ),
                base_version: None,
            })
            .unwrap();
        let session = state.create_element("session", "Session 1", None).unwrap();
        state
            .save_element(SaveElementInput {
                id: session.meta.id.clone(),
                name: "Session 1".into(),
                tags: Vec::new(),
                body: format!(
                    "# Session 1\n\nAt the [inn](cf://element/{}).\n",
                    inn.meta.id
                ),
                extra: None,
                base_version: None,
            })
            .unwrap();

        let before = state.read_element(&inn.meta.id).unwrap();

        // Deleted: out of the list and unreadable, but in the trash.
        state.delete_element(&inn.meta.id).unwrap();
        assert!(!root.0.join(&inn.meta.path).exists());
        assert!(matches!(
            state.read_element(&inn.meta.id),
            Err(StorageError::ElementNotFound(_))
        ));
        assert_eq!(state.list_elements().unwrap().len(), 1);
        assert_eq!(state.list_trash().unwrap().len(), 1);

        // Restored: the same file name, id, tags, fields and body, with the
        // trash keys gone, so the session's link resolves again.
        let restored = state.restore_element(&inn.meta.id).unwrap();
        assert_eq!(restored.meta.id, inn.meta.id);
        assert_eq!(restored.meta.path, inn.meta.path);
        assert_eq!(restored.meta.tags, vec!["inn".to_owned()]);
        assert_eq!(restored.body, before.body);
        // Byte for byte the file it was.
        assert_eq!(restored.version, before.version);
        assert_eq!(
            restored.meta.extra.get("shared"),
            Some(&serde_json::Value::Bool(true))
        );
        assert!(!restored.meta.extra.contains_key("deletedAt"));
        assert!(!restored.meta.extra.contains_key("deletedFrom"));
        assert!(state.list_trash().unwrap().is_empty());
        assert!(!root.0.join(".trash").join("location").exists());
        assert!(state.read_element(&inn.meta.id).is_ok());
        assert_eq!(state.list_elements().unwrap().len(), 2);
        let session = state.read_element(&session.meta.id).unwrap();
        assert!(session.links.contains(&inn.meta.id));
        let on_disk = std::fs::read_to_string(root.0.join(&inn.meta.path)).unwrap();
        assert!(!on_disk.contains("deleted"));

        // An element that is not deleted cannot be restored.
        assert!(matches!(
            state.restore_element(&inn.meta.id),
            Err(StorageError::InvalidInput(_))
        ));

        // Purged: gone for good.
        state.delete_element(&session.meta.id).unwrap();
        state.purge_element(&session.meta.id).unwrap();
        assert!(state.list_trash().unwrap().is_empty());
        assert!(matches!(
            state.restore_element(&session.meta.id),
            Err(StorageError::ElementNotFound(_))
        ));

        // Aged past the keep window: pruned when the campaign is next opened.
        state.delete_element(&inn.meta.id).unwrap();
        let trashed = root
            .0
            .join(&state.list_trash().unwrap()[0].summary.meta.path);
        let text = std::fs::read_to_string(&trashed).unwrap();
        let aged: String = text
            .lines()
            .map(|line| {
                if line.starts_with("deletedAt:") {
                    "deletedAt: 2000-01-01T00:00:00Z"
                } else {
                    line
                }
            })
            .collect::<Vec<_>>()
            .join("\n");
        std::fs::write(&trashed, aged).unwrap();
        let fresh = AppState::default();
        fresh.open_campaign(root.path()).unwrap();
        assert!(fresh.list_trash().unwrap().is_empty());
        assert!(!trashed.exists());
        assert_eq!(fresh.list_elements().unwrap().len(), 0);
    }

    #[test]
    fn change_kind_moves_the_file_and_keeps_everything_else() {
        let root = TempRoot::new("changekind");
        let state = AppState::default();
        state
            .create_campaign(root.path(), "Kinds".into(), None)
            .unwrap();
        let extra: Extra = serde_json::from_str(r#"{"date":"2026-11-17","shared":true}"#).unwrap();
        let entry = state
            .create_element("journal", "Ambush at the ford", Some(extra))
            .unwrap();
        state
            .save_element(SaveElementInput {
                id: entry.meta.id.clone(),
                name: entry.meta.name.clone(),
                tags: vec!["fight".into()],
                body: "## Setup\n\nGoblins.\n".into(),
                extra: None,
                base_version: None,
            })
            .unwrap();

        let changed = state
            .change_element_kind(&entry.meta.id, "encounter")
            .unwrap();
        assert_eq!(changed.meta.id, entry.meta.id);
        assert_eq!(changed.meta.kind, "encounter");
        assert_eq!(
            changed.meta.path,
            "elements/encounter/ambush-at-the-ford.md"
        );
        assert_eq!(changed.meta.tags, vec!["fight".to_owned()]);
        assert_eq!(changed.meta.extra["date"], "2026-11-17");
        assert_eq!(changed.meta.extra["shared"], true);
        assert_eq!(changed.body.trim_start(), "## Setup\n\nGoblins.\n");
        assert!(!root.0.join(&entry.meta.path).exists());
        assert!(root.0.join(&changed.meta.path).is_file());

        // The index follows the file: reads and saves find it at the new path.
        let read = state.read_element(&entry.meta.id).unwrap();
        assert_eq!(read.meta.kind, "encounter");
        assert_eq!(read.version, changed.version);
        let listed = state.list_elements().unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].meta.kind, "encounter");

        // Same kind again is a no-op that returns the element as it is.
        let again = state
            .change_element_kind(&entry.meta.id, "encounter")
            .unwrap();
        assert_eq!(again.version, changed.version);

        // A fresh scan agrees.
        let fresh = AppState::default();
        fresh.open_campaign(root.path()).unwrap();
        assert_eq!(fresh.list_elements().unwrap()[0].meta.kind, "encounter");

        // A file dragged into a kind's folder by hand still says the old
        // kind. Fixing it keeps the file where it is, under its own name.
        let dragged = state.create_element("journal", "Dragged", None).unwrap();
        let from = root.0.join(&dragged.meta.path);
        let to = root.0.join("elements/encounter/dragged.md");
        std::fs::rename(&from, &to).unwrap();
        let rescanned = AppState::default();
        rescanned.open_campaign(root.path()).unwrap();
        let fixed = rescanned
            .change_element_kind(&dragged.meta.id, "encounter")
            .unwrap();
        assert_eq!(fixed.meta.kind, "encounter");
        assert_eq!(fixed.meta.path, "elements/encounter/dragged.md");
        assert!(!root.0.join("elements/encounter/dragged-2.md").exists());
        assert_eq!(
            rescanned.read_element(&dragged.meta.id).unwrap().meta.kind,
            "encounter"
        );
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
    fn missed_unshare_withdraws_summaries_and_assets_without_a_watcher_event() {
        use crate::table::share::{shared_asset_paths, shared_element, shared_summaries};
        let root = TempRoot::new("missed-unshare");
        let state = AppState::default();
        state
            .create_campaign(root.path(), "Watch".into(), None)
            .unwrap();
        let item = state
            .create_element(
                "npc",
                "Harbor",
                Some(
                    serde_json::from_value(
                        serde_json::json!({"shared": true, "portrait":"images/public.png"}),
                    )
                    .unwrap(),
                ),
            )
            .unwrap();
        let path = root.0.join(&item.meta.path);
        let text = std::fs::read_to_string(&path).unwrap();
        std::fs::write(&path, text.replace("shared: true", "shared: false")).unwrap();
        let before = state.version();
        assert!(shared_asset_paths(&state, None).unwrap().is_empty());
        assert!(state.version() > before);
        assert!(shared_summaries(&state, None).unwrap().is_empty());
        assert!(
            shared_element(&state, &item.meta.id, None)
                .unwrap()
                .is_none()
        );
        let after = state.version();
        state.refresh_table().unwrap();
        assert_eq!(state.version(), after);
        // Invalid UTF-8 is a non-NotFound I/O error on every platform.
        std::fs::write(&path, [0xff]).unwrap();
        assert!(state.apply_disk_changes(&[path]).unwrap().is_empty());
        assert_eq!(state.table_entries().unwrap().len(), 1);
    }

    #[test]
    fn replaced_handout_withdraws_its_old_identity() {
        let root = TempRoot::new("replace-id");
        let state = AppState::default();
        state
            .create_campaign(root.path(), "Watch".into(), None)
            .unwrap();
        let handout = state
            .create_element(
                "location",
                "Harbor",
                Some(serde_json::from_value(serde_json::json!({"shared": true})).unwrap()),
            )
            .unwrap();
        let file = root.0.join(&handout.meta.path);
        let original = std::fs::read_to_string(&file).unwrap();
        std::fs::write(&file, original.replace(&handout.meta.id, "replacement")).unwrap();
        state
            .apply_disk_changes(std::slice::from_ref(&file))
            .unwrap();
        let entries = state.table_entries().unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].summary.meta.id, "replacement");
        assert!(state.read_element(&handout.meta.id).is_err());
        std::fs::write(&file, "incomplete frontmatter").unwrap();
        state
            .apply_disk_changes(std::slice::from_ref(&file))
            .unwrap();
        assert!(state.table_entries().unwrap().is_empty());
        std::fs::write(&file, original).unwrap();
        state.apply_disk_changes(&[file]).unwrap();
        assert_eq!(
            state.table_entries().unwrap()[0].summary.meta.id,
            handout.meta.id
        );
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
