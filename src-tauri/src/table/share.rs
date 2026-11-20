//! What players may see. The single implementation of the sharing rules,
//! used both by the GM's "preview as player" and by the table server, so the
//! preview can never differ from what players actually receive.
//!
//! Rules:
//! - An element is visible only when its frontmatter has `shared: true`,
//!   and, when it also lists an `audience` of player ids, only to those
//!   players. A viewer with no player id (a browser, or the GM previewing as
//!   anyone) sees elements with no audience.
//! - Links to elements that are not visible are turned back into plain text,
//!   in bodies and in the derived `links` list, so private names never leak.
//! - Maps keep only pins, routes and territories that are themselves
//!   `shared: true`; a kept item's `element` link is dropped unless visible.
//! - Sessions lose their prep `beats`; an `arc` link is dropped unless visible.
//! - Journal entries scoped to a private arc or session fall back to the
//!   campaign scope.
//! - Encounters keep their turn order (names, initiative, conditions, who is
//!   down), but each combatant loses the GM's `notes`, its hit points and
//!   AC, and its `element` link is dropped unless visible.
//! - A body may contain a `## Players know` heading. When it does, players
//!   receive only that section (up to the next heading of the same or a
//!   higher level); the rest of the body is GM-only. Without the heading the
//!   whole body is shared, as before.
//! - A `note` written by a player at the table names them as `author`. The
//!   author always receives their own notes, whole, shared or not, and is
//!   the only player who may change or delete them; sharing one sends it
//!   to everyone like any other element. The GM sees every note.

use std::collections::HashSet;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

use crate::storage::{
    AppState, Element, ElementSummary, Extra, SaveElementInput, StorageError, extract_links,
};

const LINK_PREFIX: &str = "cf://element/";
const UUID_LEN: usize = 36;

/// The kind of a note: a page anyone at the table may write.
pub const NOTE_KIND: &str = "note";

/// What a note is called when its author gives it no title.
const UNTITLED_NOTE: &str = "Untitled note";

pub fn is_shared(extra: &Extra) -> bool {
    extra.get("shared") == Some(&Value::Bool(true))
}

/// Who is looking: the table name they joined with and, once their device
/// is paired, their player id. `None` means "anyone".
#[derive(Debug, Clone, Copy)]
pub struct Viewer<'a> {
    pub name: &'a str,
    pub player_id: Option<&'a str>,
}

/// Shared, and either for everyone or for this viewer's player.
pub fn visible_to(extra: &Extra, viewer: Option<&Viewer<'_>>) -> bool {
    if !is_shared(extra) {
        return false;
    }
    let audience: Vec<&str> = extra
        .get("audience")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();
    if audience.is_empty() {
        return true;
    }
    match viewer.and_then(|v| v.player_id) {
        Some(id) => audience.contains(&id),
        None => false,
    }
}

/// Whether `extra` names the viewer as its `author`: their player id since
/// pairing, or the table name they joined with before that.
fn is_author(extra: &Extra, viewer: &Viewer<'_>) -> bool {
    extra
        .get("author")
        .and_then(Value::as_str)
        .map(str::trim)
        .is_some_and(|author| {
            !author.is_empty()
                && (viewer.player_id == Some(author)
                    || author.eq_ignore_ascii_case(viewer.name.trim()))
        })
}

/// A note this viewer wrote: theirs to read, change and delete.
pub fn is_own_note(kind: &str, extra: &Extra, viewer: &Viewer<'_>) -> bool {
    kind == NOTE_KIND && is_author(extra, viewer)
}

/// Shared with this viewer, or a note of their own.
fn can_see(kind: &str, extra: &Extra, viewer: Option<&Viewer<'_>>) -> bool {
    visible_to(extra, viewer) || viewer.is_some_and(|v| is_own_note(kind, extra, v))
}

/// Ids of every element the viewer may see in the open campaign.
fn shared_ids(all: &[ElementSummary], viewer: Option<&Viewer<'_>>) -> HashSet<String> {
    all.iter()
        .filter(|e| can_see(&e.meta.kind, &e.meta.extra, viewer))
        .map(|e| e.meta.id.clone())
        .collect()
}

/// Summaries of all shared elements, sanitised.
pub fn shared_summaries(
    state: &AppState,
    viewer: Option<&Viewer<'_>>,
) -> Result<Vec<ElementSummary>, StorageError> {
    state.refresh_table()?;
    Ok(shared_versions(state, viewer)?
        .into_iter()
        .map(|(summary, _)| summary)
        .collect())
}

pub(super) fn shared_versions(
    state: &AppState,
    viewer: Option<&Viewer<'_>>,
) -> Result<Vec<(ElementSummary, String)>, StorageError> {
    let entries = state.table_entries()?;
    let visible: HashSet<_> = entries
        .iter()
        .filter(|entry| can_see(&entry.summary.meta.kind, &entry.summary.meta.extra, viewer))
        .map(|entry| entry.summary.meta.id.clone())
        .collect();
    let mut summaries = Vec::new();
    for entry in entries {
        let mut summary = entry.summary;
        if !visible.contains(&summary.meta.id) {
            continue;
        }
        if !viewer.is_some_and(|v| is_own_note(&summary.meta.kind, &summary.meta.extra, v)) {
            summary.links = entry.player_links;
        }
        summaries.push((sanitize_summary(summary, &visible), entry.version));
    }
    summaries.sort_by(|(a, _), (b, _)| {
        (&a.meta.kind, &a.meta.name, &a.meta.id).cmp(&(&b.meta.kind, &b.meta.name, &b.meta.id))
    });
    Ok(summaries)
}

/// One shared element with its body, or `None` when it is not shared.
pub fn shared_element(
    state: &AppState,
    id: &str,
    viewer: Option<&Viewer<'_>>,
) -> Result<Option<Element>, StorageError> {
    let all = state.list_elements()?;
    let visible = shared_ids(&all, viewer);
    if !visible.contains(id) {
        return Ok(None);
    }
    let element = state.read_element(id)?;
    if element.meta.id != id || !can_see(&element.meta.kind, &element.meta.extra, viewer) {
        return Ok(None);
    }
    let own = viewer.is_some_and(|v| is_own_note(&element.meta.kind, &element.meta.extra, v));
    Ok(Some(sanitize_element(element, &visible, own)))
}

/// What a player sends to create or change a note of their own.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteInput {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub body: String,
    /// Share the note with everyone at the table, or take it back. Absent
    /// leaves it as it is.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shared: Option<bool>,
    /// The `version` the edit started from; absent overwrites.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_version: Option<String>,
}

/// Creates a note by this viewer as a file in the campaign folder, private
/// to its author and the GM until the author shares it.
pub fn create_note(
    state: &AppState,
    viewer: &Viewer<'_>,
    input: NoteInput,
) -> Result<Element, StorageError> {
    let name = input.name.trim();
    let name = if name.is_empty() { UNTITLED_NOTE } else { name };
    let author = viewer.player_id.unwrap_or(viewer.name).trim();
    if author.is_empty() {
        return Err(StorageError::InvalidInput("a note needs an author".into()));
    }
    let mut extra = Extra::new();
    extra.insert("author".to_owned(), Value::String(author.to_owned()));
    extra.insert(
        "authorName".to_owned(),
        Value::String(viewer.name.trim().to_owned()),
    );
    extra.insert("shared".to_owned(), Value::Bool(input.shared == Some(true)));
    let created = state.create_element(NOTE_KIND, name, Some(extra))?;
    // A new file opens with its name as a heading; a note's title is its
    // name already, so the body is what the author wrote and nothing else.
    let saved = state.save_element_unseen(SaveElementInput {
        id: created.meta.id.clone(),
        name: created.meta.name.clone(),
        tags: Vec::new(),
        body: input.body,
        extra: Some(created.meta.extra.clone()),
        base_version: Some(created.version.clone()),
    })?;
    let all = state.list_elements()?;
    let visible = shared_ids(&all, Some(viewer));
    Ok(sanitize_element(saved, &visible, true))
}

/// Replaces the title, body and sharing of a note the viewer wrote. `None`
/// when there is no such note or it is not theirs.
pub fn update_note(
    state: &AppState,
    id: &str,
    viewer: &Viewer<'_>,
    input: NoteInput,
) -> Result<Option<Element>, StorageError> {
    let element = match state.read_element(id) {
        Ok(e) => e,
        Err(StorageError::ElementNotFound(_)) => return Ok(None),
        Err(e) => return Err(e),
    };
    if !is_own_note(&element.meta.kind, &element.meta.extra, viewer) {
        return Ok(None);
    }
    let name = input.name.trim();
    let name = if name.is_empty() {
        element.meta.name.clone()
    } else {
        name.to_owned()
    };
    let mut extra = element.meta.extra.clone();
    if let Some(shared) = input.shared {
        extra.insert("shared".to_owned(), Value::Bool(shared));
    }
    let saved = state.save_element_unseen(SaveElementInput {
        id: element.meta.id.clone(),
        name,
        tags: element.meta.tags.clone(),
        body: input.body,
        extra: Some(extra),
        base_version: input.base_version,
    })?;
    let all = state.list_elements()?;
    let visible = shared_ids(&all, Some(viewer));
    Ok(Some(sanitize_element(saved, &visible, true)))
}

/// Deletes a note the viewer wrote, file and all. `false` when there is no
/// such note or it is not theirs.
pub fn delete_note(state: &AppState, id: &str, viewer: &Viewer<'_>) -> Result<bool, StorageError> {
    let element = match state.read_element(id) {
        Ok(e) => e,
        Err(StorageError::ElementNotFound(_)) => return Ok(false),
        Err(e) => return Err(e),
    };
    if !is_own_note(&element.meta.kind, &element.meta.extra, viewer) {
        return Ok(false);
    }
    state.delete_element(id)?;
    Ok(true)
}

/// Whether a player may edit a character's sheet: the element is shared,
/// is a character, and its sheet names them as `owner`.
pub fn can_edit_sheet(e: &Element, viewer: &Viewer<'_>) -> bool {
    if e.meta.kind != "character" || !visible_to(&e.meta.extra, Some(viewer)) {
        return false;
    }
    sheet_owner(&e.meta.extra).is_some_and(|o| {
        let o = o.trim();
        !o.is_empty() && (viewer.player_id == Some(o) || o.eq_ignore_ascii_case(viewer.name.trim()))
    })
}

fn sheet_owner(extra: &Extra) -> Option<&str> {
    extra
        .get("sheet")
        .and_then(Value::as_object)
        .and_then(|s| s.get("owner"))
        .and_then(Value::as_str)
}

/// Replaces a character's sheet on behalf of its owning player. The owner
/// field itself stays as the GM set it. `None` when the player may not.
pub fn update_sheet(
    state: &AppState,
    id: &str,
    viewer: &Viewer<'_>,
    mut sheet: Value,
    base_version: String,
) -> Result<Option<Element>, StorageError> {
    let element = match state.read_element(id) {
        Ok(e) => e,
        Err(StorageError::ElementNotFound(_)) => return Ok(None),
        Err(e) => return Err(e),
    };
    if !can_edit_sheet(&element, viewer) {
        return Ok(None);
    }
    let Some(new) = sheet.as_object_mut() else {
        return Err(StorageError::InvalidInput("sheet must be an object".into()));
    };
    if let Some(owner) = sheet_owner(&element.meta.extra) {
        new.insert("owner".to_owned(), Value::String(owner.to_owned()));
    }
    let mut extra = element.meta.extra.clone();
    extra.insert("sheet".to_owned(), sheet);
    let saved = state.save_element_unseen(SaveElementInput {
        id: element.meta.id.clone(),
        name: element.meta.name.clone(),
        tags: element.meta.tags.clone(),
        body: element.body.clone(),
        extra: Some(extra),
        base_version: Some(base_version),
    })?;
    let all = state.list_elements()?;
    let visible = shared_ids(&all, Some(viewer));
    Ok(Some(sanitize_element(saved, &visible, false)))
}

/// Relative asset paths players may fetch: the images of shared maps, the
/// portraits of shared elements and the PDFs of shared documents.
pub fn shared_asset_paths(
    state: &AppState,
    viewer: Option<&Viewer<'_>>,
) -> Result<HashSet<String>, StorageError> {
    let mut out = HashSet::new();
    for e in shared_summaries(state, viewer)? {
        if e.meta.kind == "map"
            && let Some(image) = e.meta.extra.get("image").and_then(Value::as_str)
        {
            out.insert(image.to_owned());
        }
        if let Some(portrait) = e.meta.extra.get("portrait").and_then(Value::as_str) {
            out.insert(portrait.to_owned());
        }
        if e.meta.kind == "document"
            && let Some(file) = e.meta.extra.get("file").and_then(Value::as_str)
        {
            out.insert(file.to_owned());
        }
    }
    Ok(out)
}

fn sanitize_summary(mut e: ElementSummary, visible: &HashSet<String>) -> ElementSummary {
    e.links.retain(|id| visible.contains(id));
    sanitize_extra(&e.meta.kind, &mut e.meta.extra, visible);
    e
}

/// With `whole_body` (a note read by its author) the "Players know" rule is
/// skipped; private links are still turned to text.
fn sanitize_element(mut e: Element, visible: &HashSet<String>, whole_body: bool) -> Element {
    sanitize_extra(&e.meta.kind, &mut e.meta.extra, visible);
    let body = if whole_body {
        e.body.clone()
    } else {
        player_body(&e.body).0
    };
    e.body = strip_private_links(&body, visible);
    e.links = extract_links(&e.body);
    e.links.retain(|id| visible.contains(id));
    e
}

/// The part of a body players get, and whether a "Players know" section was
/// found. With the section, only its contents (heading excluded) are kept.
pub fn player_body(body: &str) -> (String, bool) {
    let mut out: Vec<&str> = Vec::new();
    let mut level: Option<usize> = None;
    for line in body.lines() {
        match (level, heading_of(line)) {
            (None, Some((l, text))) if is_players_heading(text) => level = Some(l),
            (None, _) => {}
            (Some(l), Some((h, _))) if h <= l => break,
            (Some(_), _) => out.push(line),
        }
    }
    match level {
        Some(_) => (out.join("\n").trim().to_owned(), true),
        None => (body.to_owned(), false),
    }
}

/// Markdown ATX heading: level and text, if the line is one.
fn heading_of(line: &str) -> Option<(usize, &str)> {
    let trimmed = line.trim_end();
    let level = trimmed.bytes().take_while(|b| *b == b'#').count();
    if level == 0 || level > 6 {
        return None;
    }
    let rest = &trimmed[level..];
    if !rest.is_empty() && !rest.starts_with(' ') {
        return None;
    }
    Some((level, rest.trim().trim_end_matches('#').trim()))
}

fn is_players_heading(text: &str) -> bool {
    let t = text
        .trim()
        .trim_end_matches([':', '.'])
        .to_ascii_lowercase();
    matches!(
        t.as_str(),
        "players know"
            | "what players know"
            | "what the players know"
            | "player-facing"
            | "player facing"
    )
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
        "encounter" => {
            if let Some(Value::Array(items)) = extra.get_mut("combatants") {
                for item in items.iter_mut() {
                    if let Some(obj) = item.as_object_mut() {
                        for key in ["notes", "hp", "hpMax", "ac"] {
                            obj.remove(key);
                        }
                        drop_private_ref(obj, "element", visible);
                    }
                }
            }
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
    fn whole_body_without_a_players_section() {
        let (body, found) = player_body("# Villain\n\nSecret plans.");
        assert!(!found);
        assert_eq!(body, "# Villain\n\nSecret plans.");
    }

    #[test]
    fn only_the_players_section_is_kept() {
        let body = "Secret plans here.\n\n## Players know\n\nA kindly merchant.\n\n### Rumours\n\nHe travels a lot.\n\n## GM notes\n\nHe is the lich.\n";
        let (out, found) = player_body(body);
        assert!(found);
        assert_eq!(
            out,
            "A kindly merchant.\n\n### Rumours\n\nHe travels a lot."
        );
    }

    #[test]
    fn players_heading_variants_and_levels() {
        let (out, found) = player_body("# What the players know:\nSeen once.\n# Truth\nNo.");
        assert!(found);
        assert_eq!(out, "Seen once.");
        assert!(!player_body("## Players knowledge\nx").1);
        assert!(!player_body("#NotAHeading players know\nx").1);
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
    fn encounters_lose_combatant_notes_and_private_links() {
        let mut extra: Extra = serde_json::from_value(json!({
            "status": "running", "round": 2, "turn": 1,
            "combatants": [
                { "id": "c1", "element": A, "name": "Ivel", "hp": 12, "notes": "secretly the lich" },
                { "id": "c2", "element": B, "name": "Goblin", "hp": 7, "notes": "flees at half" },
                { "id": "c3", "name": "Guard", "hp": 11 }
            ]
        }))
        .unwrap();
        sanitize_extra("encounter", &mut extra, &visible(&[A]));
        let combatants = extra["combatants"].as_array().unwrap();
        assert_eq!(combatants.len(), 3);
        assert_eq!(combatants[0]["element"], json!(A));
        assert!(combatants[1].get("element").is_none());
        assert!(combatants.iter().all(|c| c.get("notes").is_none()));
        assert!(combatants.iter().all(|c| c.get("hp").is_none()));
        assert_eq!(combatants[1]["name"], json!("Goblin"));
        assert_eq!(extra["round"], json!(2));
    }

    #[test]
    fn notes_reach_their_author_shared_or_not() {
        let private: Extra =
            serde_json::from_value(json!({ "author": A, "authorName": "Mira" })).unwrap();
        let mira = Viewer {
            name: "Mira",
            player_id: Some(A),
        };
        let tam = Viewer {
            name: "Tam",
            player_id: Some(B),
        };
        assert!(can_see("note", &private, Some(&mira)));
        assert!(!can_see("note", &private, Some(&tam)));
        assert!(!can_see("note", &private, None));
        // The author rule is for notes only: a character naming them is not theirs.
        assert!(!can_see("character", &private, Some(&mira)));

        let shared: Extra = serde_json::from_value(json!({ "author": A, "shared": true })).unwrap();
        assert!(can_see("note", &shared, Some(&tam)));
        assert!(can_see("note", &shared, None));
    }

    #[test]
    fn notes_from_before_pairing_match_the_table_name() {
        let extra: Extra = serde_json::from_value(json!({ "author": "Mira" })).unwrap();
        let unpaired = Viewer {
            name: " mira ",
            player_id: None,
        };
        let other = Viewer {
            name: "Tam",
            player_id: Some(A),
        };
        assert!(is_own_note("note", &extra, &unpaired));
        assert!(!is_own_note("note", &extra, &other));
        let blank: Extra = serde_json::from_value(json!({ "author": "  " })).unwrap();
        assert!(!is_own_note("note", &blank, &unpaired));
    }

    #[test]
    fn journal_scope_falls_back_to_campaign() {
        let mut extra: Extra =
            serde_json::from_value(json!({ "scope": { "type": "session", "id": B } })).unwrap();
        sanitize_extra("journal", &mut extra, &visible(&[A]));
        assert_eq!(extra["scope"], json!({ "type": "campaign" }));
    }
}
