//! Minimal YAML frontmatter split/join.
//!
//! A document is frontmatter if it starts with a line that is exactly `---`,
//! followed by YAML, followed by another `---` line. Everything after that is
//! the body. Line endings may be `\n` or `\r\n`.

/// Splits a document into `(yaml, body)`. Returns `None` if the document has
/// no frontmatter block.
pub fn split(text: &str) -> Option<(&str, &str)> {
    let rest = text.strip_prefix("---")?;
    let rest = rest
        .strip_prefix("\r\n")
        .or_else(|| rest.strip_prefix('\n'))?;

    // Find the closing delimiter at the start of a line.
    let mut offset = 0;
    for line in rest.split_inclusive('\n') {
        let trimmed = line.trim_end_matches(['\r', '\n']);
        if trimmed == "---" {
            let yaml = &rest[..offset];
            let body = &rest[offset + line.len()..];
            return Some((yaml, body));
        }
        offset += line.len();
    }
    None
}

/// Joins YAML and body back into a document.
pub fn join(yaml: &str, body: &str) -> String {
    let yaml = yaml.trim_end_matches('\n');
    let body = body.trim_start_matches(['\r', '\n']);
    let mut out = String::with_capacity(yaml.len() + body.len() + 16);
    out.push_str("---\n");
    out.push_str(yaml);
    out.push_str("\n---\n\n");
    out.push_str(body);
    if !out.ends_with('\n') {
        out.push('\n');
    }
    out
}

#[cfg(test)]
mod tests {
    use super::{join, split};

    #[test]
    fn splits_unix() {
        let doc = "---\nname: Bob\n---\n\n# Bob\n";
        let (yaml, body) = split(doc).unwrap();
        assert_eq!(yaml, "name: Bob\n");
        assert_eq!(body, "\n# Bob\n");
    }

    #[test]
    fn splits_windows() {
        let doc = "---\r\nname: Bob\r\n---\r\nbody";
        let (yaml, body) = split(doc).unwrap();
        assert_eq!(yaml, "name: Bob\r\n");
        assert_eq!(body, "body");
    }

    #[test]
    fn none_without_frontmatter() {
        assert!(split("# Just a heading\n").is_none());
    }

    #[test]
    fn round_trips() {
        let doc = join("name: Bob", "# Bob\n");
        let (yaml, body) = split(&doc).unwrap();
        assert_eq!(yaml.trim(), "name: Bob");
        assert_eq!(body.trim(), "# Bob");
    }
}
