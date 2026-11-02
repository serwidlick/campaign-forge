use serde::{Deserialize, Serialize};

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
}

/// A full element: frontmatter plus Markdown body.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Element {
    #[serde(flatten)]
    pub meta: ElementMeta,
    pub body: String,
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
}

pub fn now_rfc3339() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

pub fn new_id() -> String {
    uuid::Uuid::new_v4().to_string()
}
