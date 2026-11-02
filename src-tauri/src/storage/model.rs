use serde::{Deserialize, Serialize};

/// Kind-specific frontmatter fields (e.g. a session's `beats`, `arc`, `number`).
/// Kept as loose JSON so the storage layer stays agnostic about kinds and
/// unknown keys written by other tools survive a round trip untouched.
pub type Extra = serde_json::Map<String, serde_json::Value>;

/// Metadata for a campaign, persisted as `campaign.json`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CampaignMeta {
    pub id: String,
    pub name: String,
    /// Game system, e.g. "D&D 5e", "Daggerheart", "Call of Cthulhu". Free text.
    #[serde(default)]
    pub system: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    /// Absolute path of the campaign folder. Runtime-only; filled on open and
    /// never written to disk.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub path: String,
}

/// Frontmatter of an element file, plus its path relative to the campaign root.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ElementMeta {
    pub id: String,
    /// Element kind, e.g. "character", "faction", "location". Also the folder name.
    #[serde(rename = "type")]
    pub kind: String,
    pub name: String,
    #[serde(default)]
    pub tags: Vec<String>,
    pub created_at: String,
    pub updated_at: String,
    /// Relative path from the campaign root, with forward slashes. Runtime-only;
    /// cleared before the frontmatter is written.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub path: String,
    /// Every other frontmatter key, flattened into the same object on the wire.
    #[serde(flatten)]
    pub extra: Extra,
}

/// What the element list shows: frontmatter plus the ids this element links to.
/// `links` is derived from the body on every read and never stored.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ElementSummary {
    #[serde(flatten)]
    pub meta: ElementMeta,
    #[serde(default)]
    pub links: Vec<String>,
}

/// A full element: frontmatter, outgoing links and Markdown body.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Element {
    #[serde(flatten)]
    pub meta: ElementMeta,
    #[serde(default)]
    pub links: Vec<String>,
    pub body: String,
}

impl Element {
    pub fn summary(&self) -> ElementSummary {
        ElementSummary {
            meta: self.meta.clone(),
            links: self.links.clone(),
        }
    }
}

/// Payload for saving an existing element.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveElementInput {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub tags: Vec<String>,
    pub body: String,
    /// When present, replaces the element's kind-specific fields wholesale.
    /// When absent, the existing fields are kept.
    #[serde(default)]
    pub extra: Option<Extra>,
}

pub fn now_rfc3339() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

pub fn new_id() -> String {
    uuid::Uuid::new_v4().to_string()
}
