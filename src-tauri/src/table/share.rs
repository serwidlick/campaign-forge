//! What players may see. The single implementation of the sharing rules,
//! used both by the GM's "preview as player" and by the table server, so the
//! preview can never differ from what players actually receive.
//!
//! Rules:
//! - An element is visible only when its frontmatter has `shared: true`.
//! - Links to elements that are not visible are turned back into plain text,
//!   in bodies and in the derived `links` list, so private names never leak.
//! - Maps keep only pins, routes and territories that are themselves
//!   `shared: true`; a kept item's `element` link is dropped unless visible.
//! - Sessions lose their prep `beats`; an `arc` link is dropped unless visible.
//! - Journal entries scoped to a private arc or session fall back to the
//!   campaign scope.

use std::collections::HashSet;

use serde_json::{Map, Value, json};

use crate::storage::{AppState, Element, ElementSummary, Extra, StorageError};

const LINK_PREFIX: &str = "cf://element/";
const UUID_LEN: usize = 36;

pub fn is_shared(extra: &Extra) -> bool {
    extra.get("shared") == Some(&Value::Bool(true))
}

/// Ids of every shared element in the open campaign.
fn shared_ids(all: &[ElementSummary]) -> HashSet<String> {
    all.iter()
        .filter(|e| is_shared(&e.meta.extra))
        .map(|e| e.meta.id.clone())
        .collect()
}

/// Summaries of all shared elements, sanitised.
pub fn shared_summaries(state: &AppState) -> Result<Vec<ElementSummary>, StorageError> {
    let all = state.list_elements()?;
    let visible = shared_ids(&all);
    Ok(all
        .into_iter()
        .filter(|e| visible.contains(&e.meta.id))
        .map(|e| sanitize_summary(e, &visible))
        .collect())
}

/// One shared element with its body, or `None` when it is not shared.
pub fn shared_element(state: &AppState, id: &str) -> Result<Option<Element>, StorageError> {
    let all = state.list_elements()?;
    let visible = shared_ids(&all);
    if !visible.contains(id) {
        return Ok(None);
    }
    let element = state.read_element(id)?;
    Ok(Some(sanitize_element(element, &visible)))
}

/// Relative asset paths players may fetch: the images of shared maps.
pub fn shared_asset_paths(state: &AppState) -> Result<HashSet<String>, StorageError> {
    Ok(shared_summaries(state)?
        .iter()
        .filter(|e| e.meta.kind == "map")
        .filter_map(|e| e.meta.extra.get("image").and_then(Value::as_str))
        .map(str::to_owned)
        .collect())
}

fn sanitize_summary(mut e: ElementSummary, visible: &HashSet<String>) -> ElementSummary {
    e.links.retain(|id| visible.contains(id));
    sanitize_extra(&e.meta.kind, &mut e.meta.extra, visible);
    e
}

fn sanitize_element(mut e: Element, visible: &HashSet<String>) -> Element {
    e.links.retain(|id| visible.contains(id));
    sanitize_extra(&e.meta.kind, &mut e.meta.extra, visible);
    e.body = strip_private_links(&e.body, visible);
    e
}

fn sanitize_extra(kind: &str, extra: &mut Extra, visible: &HashSet<String>) {
    match kind {
        "map" => {
            for key in ["pins", "routes", "territories"] {
                if let Some(Value::Array(items)) = extra.get_mut(key) {
                    items.retain(|item| item.get("shared") == Some(&Value::Bool(true)));
                    for item in items.iter_mut() {
                        if let Some(obj) = item.as_object_mut() {
                            drop_private_ref(obj, "element", visible);
                        }
                    }
                }
            }
        }
        "session" => {
            extra.remove("beats");
            drop_private_ref(extra, "arc", visible);
        }
        "journal" => {
            let private_scope = extra
                .get("scope")
                .and_then(Value::as_object)
                .and_then(|scope| scope.get("id"))
                .and_then(Value::as_str)
                .is_some_and(|id| !visible.contains(id));
            if private_scope {
                extra.insert("scope".to_owned(), json!({ "type": "campaign" }));
            }
        }
        _ => {}
    }
}

/// Removes `key` from `obj` when it names an element that is not visible.
fn drop_private_ref(obj: &mut Map<String, Value>, key: &str, visible: &HashSet<String>) {
    let private = obj
        .get(key)
        .and_then(Value::as_str)
        .is_some_and(|id| !visible.contains(id));
    if private {
        obj.remove(key);
    }
}

/// Rewrites `[text](cf://element/<id>)` to `text` for every id not in `visible`.
pub fn strip_private_links(body: &str, visible: &HashSet<String>) -> String {
    const MID: &str = "](";
    let mut out = String::with_capacity(body.len());
    let mut rest = body;
    while let Some(pos) = rest.find(MID) {
        let after = &rest[pos + MID.len()..];
        let Some(target) = after.strip_prefix(LINK_PREFIX) else {
            out.push_str(&rest[..pos + MID.len()]);
            rest = after;
            continue;
        };
        let id_ok = target.len() > UUID_LEN
            && target.is_char_boundary(UUID_LEN)
            && target.as_bytes()[UUID_LEN] == b')'
            && looks_like_uuid(&target[..UUID_LEN]);
        let open = rest[..pos].rfind('[');
        match (id_ok, open) {
            (true, Some(open)) => {
                let id = target[..UUID_LEN].to_ascii_lowercase();
                let text = &rest[open + 1..pos];
                out.push_str(&rest[..open]);
                if visible.contains(&id) {
                    out.push_str(&rest[open..pos + MID.len() + LINK_PREFIX.len() + UUID_LEN + 1]);
                } else {
                    out.push_str(text);
                }
                rest = &target[UUID_LEN + 1..];
            }
            _ => {
                out.push_str(&rest[..pos + MID.len()]);
                rest = after;
            }
        }
    }
    out.push_str(rest);
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
    use super::*;

    const A: &str = "11111111-2222-3333-4444-555555555555";
    const B: &str = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

    fn visible(ids: &[&str]) -> HashSet<String> {
        ids.iter().map(|s| (*s).to_owned()).collect()
    }

    #[test]
    fn strips_links_to_private_elements_only() {
        let body = format!("Met [Bob](cf://element/{A}) at [the inn](cf://element/{B}).");
        let out = strip_private_links(&body, &visible(&[A]));
        assert_eq!(out, format!("Met [Bob](cf://element/{A}) at the inn."));
    }

    #[test]
    fn leaves_ordinary_links_and_malformed_ids_alone() {
        let body = "See [docs](https://example.com) and [x](cf://element/nope).";
        assert_eq!(strip_private_links(body, &visible(&[])), body);
    }

    #[test]
    fn handles_links_at_edges_and_without_bracket() {
        let body = format!("[A](cf://element/{A})](cf://element/{B})");
        let out = strip_private_links(&body, &visible(&[]));
        assert_eq!(out, format!("A](cf://element/{B})"));
    }

    #[test]
    fn maps_keep_only_shared_items_and_visible_links() {
        let mut extra: Extra = serde_json::from_value(json!({
            "pins": [
                { "id": "p1", "shared": true, "element": A },
                { "id": "p2", "shared": true, "element": B },
                { "id": "p3", "element": A }
            ],
            "routes": [{ "id": "r1" }, { "id": "r2", "shared": true }],
            "territories": [{ "id": "t1", "shared": false }]
        }))
        .unwrap();
        sanitize_extra("map", &mut extra, &visible(&[A]));
        let pins = extra["pins"].as_array().unwrap();
        assert_eq!(pins.len(), 2);
        assert_eq!(pins[0]["element"], json!(A));
        assert!(pins[1].get("element").is_none());
        assert_eq!(extra["routes"].as_array().unwrap().len(), 1);
        assert!(extra["territories"].as_array().unwrap().is_empty());
    }

    #[test]
    fn sessions_lose_beats_and_private_arcs() {
        let mut extra: Extra = serde_json::from_value(json!({
            "number": 3, "beats": [{ "id": "b" }], "arc": B
        }))
        .unwrap();
        sanitize_extra("session", &mut extra, &visible(&[A]));
        assert!(extra.get("beats").is_none());
        assert!(extra.get("arc").is_none());
        assert_eq!(extra["number"], json!(3));
    }

    #[test]
    fn journal_scope_falls_back_to_campaign() {
        let mut extra: Extra =
            serde_json::from_value(json!({ "scope": { "type": "session", "id": B } })).unwrap();
        sanitize_extra("journal", &mut extra, &visible(&[A]));
        assert_eq!(extra["scope"], json!({ "type": "campaign" }));
    }
}
