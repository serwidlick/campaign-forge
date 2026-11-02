use std::path::PathBuf;

use thiserror::Error;

#[derive(Debug, Error)]
pub enum StorageError {
    #[error("no campaign is open")]
    NoCampaignOpen,

    #[error("element not found: {0}")]
    ElementNotFound(String),

    #[error("not a campaign folder (missing campaign.json): {0}")]
    NotACampaign(PathBuf),

    #[error("folder already contains a campaign: {0}")]
    AlreadyACampaign(PathBuf),

    #[error("invalid frontmatter in {path}: {reason}")]
    InvalidFrontmatter { path: PathBuf, reason: String },

    #[error("invalid input: {0}")]
    InvalidInput(String),

    #[error("io error at {path}: {source}")]
    Io {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },

    #[error("yaml error: {0}")]
    Yaml(#[from] serde_yaml_ng::Error),

    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),

    #[error("storage lock poisoned")]
    Poisoned,
}

impl StorageError {
    pub fn io(path: impl Into<PathBuf>, source: std::io::Error) -> Self {
        StorageError::Io {
            path: path.into(),
            source,
        }
    }
}
