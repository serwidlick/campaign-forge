//! Plain-text search over every element: name, tags and body.
//!
//! Deliberately simple: a case-insensitive substring match over the files on
//! disk, ranked by where the match was found. Campaigns are hundreds of small
//! files, so a full pass is fast enough and needs no index to keep in sync.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde::Serialize;

use super::elements;
use super::error::StorageError;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub id: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub name: String,
    /// A short excerpt around the first body match, or the start of the body
    /// when the match was in the name or tags.
    pub snippet: String,
    /// Where the best match was: "name", "tag" or "body".
    pub matched_in: &'static str,
}

const SNIPPET_RADIUS: usize = 90;

pub fn search(
    root: &Path,
    index: &HashMap<String, PathBuf>,
    query: &str,
    limit: usize,
) -> Result<Vec<SearchHit>, StorageError> {
    let needle = query.trim().to_lowercase();
    if needle.is_empty() {
        return Ok(Vec::new());
    }

    let mut scored: Vec<(u8, SearchHit)> = Vec::new();
    for path in index.values() {
        let element = match elements::read(root, path) {
            Ok(e) => e,
            Err(StorageError::InvalidFrontmatter { .. }) => continue,
            Err(other) => return Err(other),
        };
        let meta = &element.meta;
        let body_lower = element.body.to_lowercase();

        let (score, matched_in, snippet) = if meta.name.to_lowercase().contains(&needle) {
            (3, "name", excerpt(&element.body, &body_lower, &needle))
        } else if meta.tags.iter().any(|t| t.to_lowercase().contains(&needle)) {
            (2, "tag", excerpt(&element.body, &body_lower, &needle))
        } else if body_lower.contains(&needle) {
            (1, "body", excerpt(&element.body, &body_lower, &needle))
        } else {
            continue;
        };

        scored.push((
            score,
            SearchHit {
                id: meta.id.clone(),
                kind: meta.kind.clone(),
                name: meta.name.clone(),
                snippet,
                matched_in,
            },
        ));
    }

    scored.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.name.cmp(&b.1.name)));
    Ok(scored.into_iter().take(limit).map(|(_, hit)| hit).collect())
}

/// Excerpt around the first match in `body`, or the start of the body if the
/// needle does not occur there. Always cut on character boundaries.
fn excerpt(body: &str, body_lower: &str, needle: &str) -> String {
    let at = body_lower.find(needle).unwrap_or(0);
    let start = floor_char_boundary(body, at.saturating_sub(SNIPPET_RADIUS));
    let end = ceil_char_boundary(body, (at + needle.len() + SNIPPET_RADIUS).min(body.len()));
    let mut out = String::new();
    if start > 0 {
        out.push('…');
    }
    out.push_str(body[start..end].trim().replace('\n', " ").as_str());
    if end < body.len() {
        out.push('…');
    }
    out
}

fn floor_char_boundary(s: &str, mut i: usize) -> usize {
    while i > 0 && !s.is_char_boundary(i) {
        i -= 1;
    }
    i
}

fn ceil_char_boundary(s: &str, mut i: usize) -> usize {
    while i < s.len() && !s.is_char_boundary(i) {
        i += 1;
    }
    i
}

#[cfg(test)]
mod tests {
    use super::excerpt;

    #[test]
    fn excerpt_handles_multibyte_text() {
        let body = "Élodie met the dragon — “Vaelor” — at the ford. ".repeat(6);
        let lower = body.to_lowercase();
        let out = excerpt(&body, &lower, "vaelor");
        assert!(out.contains("Vaelor"));
        assert!(out.starts_with('…') || out.starts_with('É'));
    }

    #[test]
    fn excerpt_without_body_match_starts_at_beginning() {
        let body = "Short body.";
        assert_eq!(excerpt(body, &body.to_lowercase(), "zzz"), "Short body.");
    }
}
