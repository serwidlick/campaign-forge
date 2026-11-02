//! Tauri commands exposed to the frontend. Each one is a thin wrapper over
//! the storage layer; keep logic out of here so it stays testable in Rust.

use tauri::State;

use crate::storage::{
    AppState, CampaignMeta, Element, ElementSummary, SaveElementInput, StorageError,
};

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
) -> CommandResult<Element> {
    state.create_element(&kind, &name).map_err(to_command_error)
}

#[tauri::command]
pub fn save_element(state: State<'_, AppState>, input: SaveElementInput) -> CommandResult<Element> {
    state.save_element(input).map_err(to_command_error)
}

#[tauri::command]
pub fn delete_element(state: State<'_, AppState>, id: String) -> CommandResult<()> {
    state.delete_element(&id).map_err(to_command_error)
}
