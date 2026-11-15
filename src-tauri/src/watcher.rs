//! Watches the open campaign's folder for edits made outside this window.
//!
//! A campaign folder can live inside OneDrive, Google Drive, Dropbox or
//! iCloud, whose sync clients rewrite files when another device changes
//! them. The user may also edit the Markdown in any other program. The
//! watcher hands each batch of changed paths to
//! [`AppState::apply_disk_changes`], which skips the app's own writes, and
//! emits [`FILES_CHANGED_EVENT`] so the window can reload what it shows.

use std::path::Path;
use std::sync::Mutex;
use std::time::Duration;

use notify_debouncer_mini::notify::{RecommendedWatcher, RecursiveMode};
use notify_debouncer_mini::{DebounceEventResult, Debouncer, new_debouncer};
use tauri::{AppHandle, Emitter, Manager};

use crate::storage::AppState;

/// Payload: [`crate::storage::DiskChanges`].
pub const FILES_CHANGED_EVENT: &str = "campaign-files-changed";

/// Sync clients often write a file in several steps; wait for them to settle.
const DEBOUNCE: Duration = Duration::from_millis(400);

/// The watcher for the open campaign. Replacing it stops the old one.
#[derive(Default)]
pub struct FolderWatch(Mutex<Option<Debouncer<RecommendedWatcher>>>);

impl FolderWatch {
    /// Starts watching `root`, replacing any earlier watcher. A failure is
    /// logged and otherwise ignored: the app still works without live reload.
    pub fn start(&self, app: &AppHandle, root: &Path) {
        let handle = app.clone();
        let debouncer = new_debouncer(DEBOUNCE, move |result: DebounceEventResult| {
            let events = match result {
                Ok(events) => events,
                Err(err) => {
                    eprintln!("folder watcher: {err}");
                    return;
                }
            };
            let paths: Vec<_> = events.into_iter().map(|e| e.path).collect();
            let state = handle.state::<AppState>();
            match state.apply_disk_changes(&paths) {
                Ok(changes) if !changes.is_empty() => {
                    let _ = handle.emit(FILES_CHANGED_EVENT, changes);
                }
                Ok(_) => {}
                Err(err) => eprintln!("folder watcher: {err}"),
            }
        });
        let mut debouncer = match debouncer {
            Ok(d) => d,
            Err(err) => {
                eprintln!("folder watcher: could not start: {err}");
                return;
            }
        };
        if let Err(err) = debouncer.watcher().watch(root, RecursiveMode::Recursive) {
            eprintln!("folder watcher: could not watch {}: {err}", root.display());
            return;
        }
        if let Ok(mut slot) = self.0.lock() {
            *slot = Some(debouncer);
        }
    }
}
