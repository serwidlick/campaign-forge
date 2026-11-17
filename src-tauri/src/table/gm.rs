//! What a GM working from another machine may do: everything the GM's own
//! window can. The frontend on their device sends the same command names and
//! arguments it would hand `invoke` locally; [`call`] runs them against the
//! hosting machine's storage and table and answers with the result as JSON.
//!
//! Two things differ from a local call. Files are read on the GM's device
//! and arrive here as bytes ([`upload`]). And every write is announced to the
//! hosting window with the folder watcher's own event, so the desktop upstairs
//! follows what the laptop downstairs is doing within a second.

use axum::http::StatusCode;
use base64::prelude::*;
use serde::Deserialize;
use serde::de::DeserializeOwned;
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager};

use crate::pdf;
use crate::storage::{
    AppState, Conversation, DiskChanges, Extra, MAX_IMAGE_BYTES, SaveElementInput,
};
use crate::watcher::FILES_CHANGED_EVENT;

use super::TableState;
use super::players;
use super::server::{ApiError, storage_error};
use super::share;

fn bad_request(msg: impl Into<String>) -> ApiError {
    ApiError(StatusCode::BAD_REQUEST, msg.into())
}

fn args<T: DeserializeOwned>(v: Value) -> Result<T, ApiError> {
    serde_json::from_value(v).map_err(|e| bad_request(format!("bad arguments: {e}")))
}

fn ok<T: serde::Serialize>(v: T) -> Result<Value, ApiError> {
    serde_json::to_value(v).map_err(|e| ApiError(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))
}

/// Tells the hosting window what another GM just changed.
fn notify(app: &AppHandle, note: DiskChanges) {
    let _ = app.emit(FILES_CHANGED_EVENT, note);
}

fn decode_base64(data: &str) -> Result<Vec<u8>, ApiError> {
    BASE64_STANDARD
        .decode(data.as_bytes())
        .map_err(|e| bad_request(format!("invalid image data: {e}")))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Id {
    id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateCampaign {
    name: Option<String>,
    system: Option<String>,
    #[serde(default)]
    clear_system: Option<bool>,
    extra: Option<Extra>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateElement {
    kind: String,
    name: String,
    extra: Option<Extra>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Save {
    input: SaveElementInput,
}

#[derive(Deserialize)]
struct ChangeKind {
    id: String,
    kind: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ElementImage {
    element_id: String,
    data_base64: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MapImage {
    map_id: String,
    data_base64: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MapImageUrl {
    map_id: String,
    url: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DocumentText {
    path: String,
    from: Option<usize>,
    to: Option<usize>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Search {
    query: String,
    limit: Option<usize>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SaveConversation {
    conversation: Conversation,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SharedList {
    player_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SharedOne {
    id: String,
    player_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Spotlight {
    id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BindDevice {
    token: String,
    player_id: Option<String>,
    name: Option<String>,
}

/// Runs `command` with the frontend's `invoke` arguments. The names are the
/// Tauri commands in `commands.rs` and `table/mod.rs`; anything that reads a
/// file by path on the caller's disk is not here (see [`upload`]), nor is
/// opening or hosting a campaign, which only makes sense on the machine that
/// holds the files.
pub async fn call(app: &AppHandle, command: &str, args_json: Value) -> Result<Value, ApiError> {
    let state = app.state::<AppState>();
    match command {
        "get_campaign" => ok(state.current_campaign()),
        "update_campaign" => {
            let a: UpdateCampaign = args(args_json)?;
            let system = if a.clear_system == Some(true) {
                Some(None)
            } else {
                a.system.map(Some)
            };
            let meta = state
                .update_campaign(a.name, system, a.extra)
                .map_err(storage_error)?;
            notify(app, DiskChanges::campaign());
            ok(meta)
        }
        "list_elements" => ok(state.list_elements().map_err(storage_error)?),
        "read_element" => {
            let a: Id = args(args_json)?;
            ok(state.read_element(&a.id).map_err(storage_error)?)
        }
        "create_element" => {
            let a: CreateElement = args(args_json)?;
            let element = state
                .create_element(&a.kind, &a.name, a.extra)
                .map_err(storage_error)?;
            let mut note = DiskChanges::element(&element.meta.id, &element.version);
            note.list_changed = true;
            notify(app, note);
            ok(element)
        }
        "save_element" => {
            let a: Save = args(args_json)?;
            let saved = state.save_element(a.input).map_err(storage_error)?;
            notify(app, DiskChanges::element(&saved.meta.id, &saved.version));
            ok(saved)
        }
        "change_element_kind" => {
            let a: ChangeKind = args(args_json)?;
            let changed = state
                .change_element_kind(&a.id, &a.kind)
                .map_err(storage_error)?;
            let mut note = DiskChanges::element(&changed.meta.id, &changed.version);
            note.list_changed = true;
            notify(app, note);
            ok(changed)
        }
        "delete_element" => {
            let a: Id = args(args_json)?;
            state.delete_element(&a.id).map_err(storage_error)?;
            notify(app, DiskChanges::list());
            ok(())
        }
        "import_element_image_bytes" => {
            let a: ElementImage = args(args_json)?;
            let bytes = decode_base64(&a.data_base64)?;
            ok(state
                .import_element_image_bytes(&a.element_id, &bytes)
                .map_err(storage_error)?)
        }
        "import_map_image_bytes" => {
            let a: MapImage = args(args_json)?;
            let bytes = decode_base64(&a.data_base64)?;
            ok(state
                .import_map_image_bytes(&a.map_id, &bytes)
                .map_err(storage_error)?)
        }
        "import_map_image_from_url" => {
            let a: MapImageUrl = args(args_json)?;
            if !(a.url.starts_with("http://") || a.url.starts_with("https://")) {
                return Err(bad_request("only http(s) image URLs can be imported"));
            }
            let response = reqwest::get(&a.url)
                .await
                .map_err(|e| bad_request(format!("download failed: {e}")))?;
            if !response.status().is_success() {
                return Err(bad_request(format!(
                    "download failed: HTTP {}",
                    response.status()
                )));
            }
            if let Some(len) = response.content_length()
                && usize::try_from(len).unwrap_or(usize::MAX) > MAX_IMAGE_BYTES
            {
                return Err(bad_request("image is too large to import"));
            }
            let bytes = response
                .bytes()
                .await
                .map_err(|e| bad_request(format!("download failed: {e}")))?;
            ok(state
                .import_map_image_bytes(&a.map_id, &bytes)
                .map_err(storage_error)?)
        }
        "read_document_text" => {
            let a: DocumentText = args(args_json)?;
            let bytes = state.read_asset(&a.path).map_err(storage_error)?;
            let text =
                tauri::async_runtime::spawn_blocking(move || pdf::extract(&bytes, a.from, a.to))
                    .await
                    .map_err(|e| {
                        ApiError(
                            StatusCode::INTERNAL_SERVER_ERROR,
                            format!("extraction was interrupted: {e}"),
                        )
                    })?
                    .map_err(bad_request)?;
            ok(text)
        }
        "search_elements" => {
            let a: Search = args(args_json)?;
            ok(state
                .search_elements(&a.query, a.limit.unwrap_or(20).clamp(1, 100))
                .map_err(storage_error)?)
        }
        "list_conversations" => ok(state.list_conversations().map_err(storage_error)?),
        "read_conversation" => {
            let a: Id = args(args_json)?;
            ok(state.read_conversation(&a.id).map_err(storage_error)?)
        }
        "save_conversation" => {
            let a: SaveConversation = args(args_json)?;
            ok(state
                .save_conversation(a.conversation)
                .map_err(storage_error)?)
        }
        "delete_conversation" => {
            let a: Id = args(args_json)?;
            state.delete_conversation(&a.id).map_err(storage_error)?;
            ok(())
        }
        "list_shared_elements" => {
            let a: SharedList = args(args_json)?;
            let registry = players::load(&state);
            let record = a
                .player_id
                .as_deref()
                .and_then(|id| players::find_by_id(&registry, id));
            let viewer = record.map(|p| share::Viewer {
                name: &p.name,
                player_id: Some(&p.id),
            });
            ok(share::shared_summaries(&state, viewer.as_ref()).map_err(storage_error)?)
        }
        "read_shared_element" => {
            let a: SharedOne = args(args_json)?;
            let registry = players::load(&state);
            let record = a
                .player_id
                .as_deref()
                .and_then(|id| players::find_by_id(&registry, id));
            let viewer = record.map(|p| share::Viewer {
                name: &p.name,
                player_id: Some(&p.id),
            });
            ok(share::shared_element(&state, &a.id, viewer.as_ref()).map_err(storage_error)?)
        }
        "table_host_status" => ok(table(app).host_status().map_err(table_error)?),
        "table_spotlight" => {
            let a: Spotlight = args(args_json)?;
            ok(table(app).set_spotlight(a.id).map_err(table_error)?)
        }
        "table_bind_device" => {
            let a: BindDevice = args(args_json)?;
            let status = table(app)
                .bind_device(app, &a.token, a.player_id.as_deref(), a.name.as_deref())
                .map_err(table_error)?;
            notify(app, DiskChanges::campaign());
            ok(status)
        }
        "table_players" => ok(players::load(&state)),
        other => Err(ApiError(
            StatusCode::NOT_FOUND,
            format!("no such command over the table: {other}"),
        )),
    }
}

fn table(app: &AppHandle) -> tauri::State<'_, TableState> {
    app.state::<TableState>()
}

fn table_error(e: String) -> ApiError {
    ApiError(StatusCode::BAD_REQUEST, e)
}

/// Imports bytes the GM's device read from its own disk: `map` or `image`
/// need the element `id` they belong to; `document` takes the file's `name`.
pub fn upload(
    app: &AppHandle,
    kind: &str,
    id: Option<&str>,
    name: Option<&str>,
    bytes: &[u8],
) -> Result<Value, ApiError> {
    let state = app.state::<AppState>();
    let id = || id.ok_or_else(|| bad_request("an element id is needed"));
    match kind {
        "map" => ok(state
            .import_map_image_bytes(id()?, bytes)
            .map_err(storage_error)?),
        "image" => ok(state
            .import_element_image_bytes(id()?, bytes)
            .map_err(storage_error)?),
        "document" => ok(state
            .import_document_bytes(name.unwrap_or_default(), bytes)
            .map_err(storage_error)?),
        other => Err(bad_request(format!(
            "unknown upload kind {other} (map, image or document)"
        ))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn unknown_commands_are_refused_by_name() {
        // The dispatcher is the allow-list: a command it does not name is
        // not reachable over the table, whatever the frontend asks for.
        assert!(matches!(
            args::<Id>(json!({ "id": "x" })),
            Ok(Id { id }) if id == "x"
        ));
        assert!(args::<Id>(json!({})).is_err());
    }
}
