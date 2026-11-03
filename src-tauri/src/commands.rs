//! Tauri commands exposed to the frontend. Each one is a thin wrapper over
//! the storage layer; keep logic out of here so it stays testable in Rust.

use base64::prelude::*;
use tauri::State;

use crate::storage::{
    AppState, CampaignMeta, Element, ElementSummary, Extra, ImportedImage, MAX_IMAGE_BYTES,
    SaveElementInput, SearchHit, StorageError,
};
use crate::table::share;

type CommandResult<T> = Result<T, String>;

fn to_command_error(err: StorageError) -> String {
    err.to_string()
}

#[tauri::command]
pub fn create_campaign(
    state: State<'_, AppState>,
    path: String,
    name: String,
    system: Option<String>,
) -> CommandResult<CampaignMeta> {
    state
        .create_campaign(path, name, system)
        .map_err(to_command_error)
}

#[tauri::command]
pub fn open_campaign(state: State<'_, AppState>, path: String) -> CommandResult<CampaignMeta> {
    state.open_campaign(path).map_err(to_command_error)
}

#[tauri::command]
pub fn get_campaign(state: State<'_, AppState>) -> CommandResult<Option<CampaignMeta>> {
    Ok(state.current_campaign())
}

/// `system` keeps the current value when omitted; `clear_system: true`
/// removes it (JSON cannot express a nested option).
#[tauri::command]
pub fn update_campaign(
    state: State<'_, AppState>,
    name: Option<String>,
    system: Option<String>,
    clear_system: Option<bool>,
    extra: Option<Extra>,
) -> CommandResult<CampaignMeta> {
    let system = if clear_system == Some(true) {
        Some(None)
    } else {
        system.map(Some)
    };
    state
        .update_campaign(name, system, extra)
        .map_err(to_command_error)
}

#[tauri::command]
pub fn list_elements(state: State<'_, AppState>) -> CommandResult<Vec<ElementSummary>> {
    state.list_elements().map_err(to_command_error)
}

#[tauri::command]
pub fn read_element(state: State<'_, AppState>, id: String) -> CommandResult<Element> {
    state.read_element(&id).map_err(to_command_error)
}

#[tauri::command]
pub fn create_element(
    state: State<'_, AppState>,
    kind: String,
    name: String,
    extra: Option<Extra>,
) -> CommandResult<Element> {
    state
        .create_element(&kind, &name, extra)
        .map_err(to_command_error)
}

#[tauri::command]
pub fn save_element(state: State<'_, AppState>, input: SaveElementInput) -> CommandResult<Element> {
    state.save_element(input).map_err(to_command_error)
}

#[tauri::command]
pub fn delete_element(state: State<'_, AppState>, id: String) -> CommandResult<()> {
    state.delete_element(&id).map_err(to_command_error)
}

#[tauri::command]
pub fn import_map_image(
    state: State<'_, AppState>,
    map_id: String,
    source: String,
) -> CommandResult<ImportedImage> {
    state
        .import_map_image(&map_id, &source)
        .map_err(to_command_error)
}

#[tauri::command]
pub fn search_elements(
    state: State<'_, AppState>,
    query: String,
    limit: Option<usize>,
) -> CommandResult<Vec<SearchHit>> {
    state
        .search_elements(&query, limit.unwrap_or(20).clamp(1, 100))
        .map_err(to_command_error)
}

/// Imports an image from base64-encoded bytes (a File dropped from a browser).
#[tauri::command]
pub fn import_map_image_bytes(
    state: State<'_, AppState>,
    map_id: String,
    data_base64: String,
) -> CommandResult<ImportedImage> {
    let bytes = BASE64_STANDARD
        .decode(data_base64.as_bytes())
        .map_err(|e| format!("invalid image data: {e}"))?;
    state
        .import_map_image_bytes(&map_id, &bytes)
        .map_err(to_command_error)
}

/// Downloads an image (an URL dragged in from a browser) and imports it.
#[tauri::command]
pub async fn import_map_image_from_url(
    state: State<'_, AppState>,
    map_id: String,
    url: String,
) -> CommandResult<ImportedImage> {
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err("only http(s) image URLs can be imported".into());
    }
    let response = reqwest::get(&url)
        .await
        .map_err(|e| format!("download failed: {e}"))?;
    if !response.status().is_success() {
        return Err(format!("download failed: HTTP {}", response.status()));
    }
    if let Some(len) = response.content_length()
        && usize::try_from(len).unwrap_or(usize::MAX) > MAX_IMAGE_BYTES
    {
        return Err("image is too large to import".into());
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|e| format!("download failed: {e}"))?;
    state
        .import_map_image_bytes(&map_id, &bytes)
        .map_err(to_command_error)
}

/// Returns raw bytes; the frontend receives an `ArrayBuffer`.
#[tauri::command]
pub fn read_asset(state: State<'_, AppState>, path: String) -> CommandResult<tauri::ipc::Response> {
    let bytes = state.read_asset(&path).map_err(to_command_error)?;
    Ok(tauri::ipc::Response::new(bytes))
}

/// Shared elements exactly as the table server would send them: the GM's
/// "preview as player" reads through this so it can never drift.
#[tauri::command]
pub fn list_shared_elements(state: State<'_, AppState>) -> CommandResult<Vec<ElementSummary>> {
    share::shared_summaries(&state).map_err(to_command_error)
}

#[tauri::command]
pub fn read_shared_element(
    state: State<'_, AppState>,
    id: String,
) -> CommandResult<Option<Element>> {
    share::shared_element(&state, &id).map_err(to_command_error)
}
