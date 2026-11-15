//! Saved assistant conversations: `conversations/<id>.json`, one file each.
//!
//! The storage layer owns only the envelope (id, title, timestamps). The rest
//! of the file (the chat as shown, the API history, the request prefix the
//! conversation was started with) belongs to the frontend and is stored and
//! returned untouched, because the API history carries signed thinking
//! blocks that must replay byte for byte.
//!
//! Conversations are GM-only. Nothing here is indexed for search, and the
//! table server serves only what `table/share.rs` allows, which is elements
//! and assets, never this folder.

use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::error::StorageError;
use super::model::{Extra, now_rfc3339};

pub const CONVERSATIONS_DIR: &str = "conversations";
const DEFAULT_TITLE: &str = "Untitled conversation";
const MAX_TITLE_CHARS: usize = 120;

/// What the conversation list needs, read without keeping the whole file.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationSummary {
    pub id: String,
    pub title: String,
    pub created_at: String,
    #[serde(default)]
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Conversation {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub created_at: String,
    #[serde(default)]
    pub updated_at: String,
    /// Everything else in the file, owned by the frontend.
    #[serde(flatten)]
    pub data: Extra,
}

impl Conversation {
    fn summary(&self) -> ConversationSummary {
        ConversationSummary {
            id: self.id.clone(),
            title: self.title.clone(),
            created_at: self.created_at.clone(),
            updated_at: self.updated_at.clone(),
        }
    }
}

/// Saved conversations, most recently updated first. Files that do not parse
/// are skipped rather than failing the whole list.
pub fn list(root: &Path) -> Result<Vec<ConversationSummary>, StorageError> {
    let dir = root.join(CONVERSATIONS_DIR);
    let entries = match fs::read_dir(&dir) {
        Ok(entries) => entries,
        Err(e) if e.kind() == ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(StorageError::io(&dir, e)),
    };
    let mut out = Vec::new();
    for entry in entries {
        let path = entry.map_err(|e| StorageError::io(&dir, e))?.path();
        if path.extension().and_then(|x| x.to_str()) != Some("json") {
            continue;
        }
        let Ok(text) = fs::read_to_string(&path) else {
            continue;
        };
        let Ok(summary) = serde_json::from_str::<ConversationSummary>(&text) else {
            continue;
        };
        // The file name is the id; ignore a file whose contents disagree.
        if path.file_stem().and_then(|s| s.to_str()) == Some(summary.id.as_str()) {
            out.push(summary);
        }
    }
    // RFC 3339 UTC timestamps sort correctly as strings.
    out.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Ok(out)
}

pub fn read(root: &Path, id: &str) -> Result<Conversation, StorageError> {
    let file = file_for(root, id)?;
    let text = match fs::read_to_string(&file) {
        Ok(text) => text,
        Err(e) if e.kind() == ErrorKind::NotFound => {
            return Err(StorageError::ConversationNotFound(id.to_owned()));
        }
        Err(e) => return Err(StorageError::io(&file, e)),
    };
    Ok(serde_json::from_str(&text)?)
}

/// Writes the conversation, stamping `updatedAt` (and `createdAt` on the
/// first save). Writes to a temporary file and renames it over the old one,
/// so a crash mid-save never leaves a half-written conversation.
pub fn save(
    root: &Path,
    mut conversation: Conversation,
) -> Result<ConversationSummary, StorageError> {
    let file = file_for(root, &conversation.id)?;
    let title: String = conversation
        .title
        .trim()
        .chars()
        .take(MAX_TITLE_CHARS)
        .collect();
    conversation.title = if title.is_empty() {
        DEFAULT_TITLE.to_owned()
    } else {
        title
    };
    let now = now_rfc3339();
    if conversation.created_at.trim().is_empty() {
        conversation.created_at = now.clone();
    }
    conversation.updated_at = now;
    // The envelope fields live on the struct; never let `data` duplicate them.
    for key in ["id", "title", "createdAt", "updatedAt"] {
        conversation.data.remove(key);
    }

    let dir = root.join(CONVERSATIONS_DIR);
    fs::create_dir_all(&dir).map_err(|e| StorageError::io(&dir, e))?;
    let text = serde_json::to_string_pretty(&conversation)?;
    let tmp = file.with_extension("json.tmp");
    fs::write(&tmp, text + "\n").map_err(|e| StorageError::io(&tmp, e))?;
    fs::rename(&tmp, &file).map_err(|e| StorageError::io(&file, e))?;
    Ok(conversation.summary())
}

pub fn delete(root: &Path, id: &str) -> Result<(), StorageError> {
    let file = file_for(root, id)?;
    match fs::remove_file(&file) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == ErrorKind::NotFound => {
            Err(StorageError::ConversationNotFound(id.to_owned()))
        }
        Err(e) => Err(StorageError::io(&file, e)),
    }
}

/// The file for an id. Ids come from the frontend, so only plain ids
/// (letters, digits and hyphens, as a UUID has) may become a file name.
fn file_for(root: &Path, id: &str) -> Result<PathBuf, StorageError> {
    let plain = !id.is_empty()
        && id.len() <= 64
        && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-');
    if !plain {
        return Err(StorageError::InvalidInput(format!(
            "conversation id must be letters, digits and hyphens: {id}"
        )));
    }
    Ok(root.join(CONVERSATIONS_DIR).join(format!("{id}.json")))
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TempRoot(PathBuf);

    impl TempRoot {
        fn new(tag: &str) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "campaign-forge-conv-{tag}-{}",
                uuid::Uuid::new_v4()
            ));
            fs::create_dir_all(&dir).unwrap();
            TempRoot(dir)
        }
    }

    impl Drop for TempRoot {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn conversation(id: &str, title: &str, data: &str) -> Conversation {
        Conversation {
            id: id.into(),
            title: title.into(),
            created_at: String::new(),
            updated_at: String::new(),
            data: serde_json::from_str(data).unwrap(),
        }
    }

    #[test]
    fn save_read_list_delete_round_trip() {
        let root = TempRoot::new("roundtrip");
        assert!(list(&root.0).unwrap().is_empty());

        let first = save(
            &root.0,
            conversation(
                "a1",
                "  Who runs the docks?  ",
                r#"{"version":1,"history":[{"role":"assistant","content":[{"type":"thinking","thinking":"","signature":"sig/+=="}]}]}"#,
            ),
        )
        .unwrap();
        assert_eq!(first.title, "Who runs the docks?");
        assert!(!first.created_at.is_empty());
        assert!(root.0.join("conversations/a1.json").is_file());
        assert!(!root.0.join("conversations/a1.json.tmp").exists());

        // Frontend data comes back exactly as given.
        let read_back = read(&root.0, "a1").unwrap();
        assert_eq!(read_back.data["version"], 1);
        assert_eq!(
            read_back.data["history"][0]["content"][0]["signature"],
            "sig/+=="
        );

        // Re-saving keeps createdAt and moves updatedAt forward or equal.
        let resaved = save(&root.0, read_back).unwrap();
        assert_eq!(resaved.created_at, first.created_at);
        assert!(resaved.updated_at >= first.updated_at);

        save(&root.0, conversation("b2", "", "{}")).unwrap();
        let listed = list(&root.0).unwrap();
        assert_eq!(listed.len(), 2);
        assert!(listed.iter().any(|c| c.title == DEFAULT_TITLE));

        delete(&root.0, "a1").unwrap();
        assert!(matches!(
            read(&root.0, "a1"),
            Err(StorageError::ConversationNotFound(_))
        ));
        assert!(matches!(
            delete(&root.0, "a1"),
            Err(StorageError::ConversationNotFound(_))
        ));
        assert_eq!(list(&root.0).unwrap().len(), 1);
    }

    #[test]
    fn list_is_newest_first_and_skips_strays() {
        let root = TempRoot::new("order");
        let dir = root.0.join(CONVERSATIONS_DIR);
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("old.json"),
            r#"{"id":"old","title":"Old","createdAt":"2026-01-01T00:00:00Z","updatedAt":"2026-01-01T00:00:00Z"}"#,
        )
        .unwrap();
        fs::write(
            dir.join("new.json"),
            r#"{"id":"new","title":"New","createdAt":"2026-01-01T00:00:00Z","updatedAt":"2026-02-01T00:00:00Z"}"#,
        )
        .unwrap();
        fs::write(dir.join("broken.json"), "{ not json").unwrap();
        fs::write(dir.join("notes.txt"), "hello").unwrap();
        fs::write(
            dir.join("renamed.json"),
            r#"{"id":"other","title":"Mismatch","createdAt":"x"}"#,
        )
        .unwrap();

        let ids: Vec<_> = list(&root.0).unwrap().into_iter().map(|c| c.id).collect();
        assert_eq!(ids, vec!["new", "old"]);
    }

    #[test]
    fn ids_cannot_escape_the_folder() {
        let root = TempRoot::new("ids");
        for bad in [
            "",
            "../campaign",
            "a/b",
            "a\\b",
            "a.b",
            "..",
            &"x".repeat(65),
        ] {
            assert!(
                matches!(read(&root.0, bad), Err(StorageError::InvalidInput(_))),
                "{bad:?} was accepted"
            );
            assert!(matches!(
                save(&root.0, conversation(bad, "t", "{}")),
                Err(StorageError::InvalidInput(_))
            ));
        }
    }

    #[test]
    fn envelope_keys_in_data_are_not_duplicated() {
        let root = TempRoot::new("dupes");
        let mut c = conversation("c3", "Real", r#"{"note":"kept"}"#);
        c.data.insert("title".into(), "Sneaky".into());
        save(&root.0, c).unwrap();
        let text = fs::read_to_string(root.0.join("conversations/c3.json")).unwrap();
        assert_eq!(text.matches("\"title\"").count(), 1);
        assert_eq!(read(&root.0, "c3").unwrap().title, "Real");
    }
}
