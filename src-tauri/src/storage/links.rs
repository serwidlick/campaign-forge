//! Outgoing links between elements.
//!
//! A link is an ordinary Markdown link whose target uses the `cf://element/<id>`
//! scheme, e.g. `[The Rusty Tankard](cf://element/7f0c6a2e-...)`. Linking by id
//! means renaming an element never breaks references; the link text is just a
//! label chosen when the link was made.

pub const LINK_PREFIX: &str = "cf://element/";
const UUID_LEN: usize = 36;

/// Returns the ids this body links to, in first-seen order, without duplicates.
pub fn extract_links(body: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for (idx, _) in body.match_indices(LINK_PREFIX) {
        let start = idx + LINK_PREFIX.len();
        let Some(candidate) = body.get(start..start + UUID_LEN) else {
            continue;
        };
        if !looks_like_uuid(candidate) {
            continue;
        }
        let id = candidate.to_ascii_lowercase();
        if !out.contains(&id) {
            out.push(id);
        }
    }
    out
}

fn looks_like_uuid(s: &str) -> bool {
    s.len() == UUID_LEN
        && s.bytes().enumerate().all(|(i, b)| match i {
            8 | 13 | 18 | 23 => b == b'-',
            _ => b.is_ascii_hexdigit(),
        })
}

#[cfg(test)]
mod tests {
    use super::extract_links;

    const A: &str = "11111111-2222-3333-4444-555555555555";
    const B: &str = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

    #[test]
    fn finds_links_in_order_without_duplicates() {
        let body = format!(
            "Met [Bob](cf://element/{A}) at [the inn](cf://element/{B}). [Bob again](cf://element/{A})."
        );
        assert_eq!(extract_links(&body), vec![A, B]);
    }

    #[test]
    fn ignores_malformed_ids() {
        let body = "[x](cf://element/not-a-uuid) and [y](cf://element/1234)";
        assert!(extract_links(body).is_empty());
    }

    #[test]
    fn ignores_other_links() {
        let body = "[docs](https://example.com) and [mail](mailto:a@b.c)";
        assert!(extract_links(body).is_empty());
    }
}
