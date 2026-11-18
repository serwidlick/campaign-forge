//! Tauri commands exposed to the frontend. Each one is a thin wrapper over
//! the storage layer; keep logic out of here so it stays testable in Rust.

use std::path::Path;

use base64::prelude::*;
use tauri::{AppHandle, State};

use crate::pdf::{self, PdfText};
use crate::storage::{
    AppState, CampaignMeta, Conversation, ConversationSummary, Element, ElementSummary, Extra,
    ImportedDocument, ImportedImage, MAX_DOCUMENT_BYTES, MAX_IMAGE_BYTES, SaveElementInput,
    SearchHit, StorageError,
};
use crate::table::share;
use crate::watcher::FolderWatch;

type CommandResult<T> = Result<T, String>;

fn to_command_error(err: StorageError) -> String {
    err.to_string()
}

#[tauri::command]
pub fn create_campaign(
    app: AppHandle,
    state: State<'_, AppState>,
    watch: State<'_, FolderWatch>,
    path: String,
    name: String,
    system: Option<String>,
) -> CommandResult<CampaignMeta> {
    let meta = state
        .create_campaign(path, name, system)
        .map_err(to_command_error)?;
    watch.start(&app, Path::new(&meta.path));
    Ok(meta)
}

#[tauri::command]
pub fn open_campaign(
    app: AppHandle,
    state: State<'_, AppState>,
    watch: State<'_, FolderWatch>,
    path: String,
) -> CommandResult<CampaignMeta> {
    let meta = state.open_campaign(path).map_err(to_command_error)?;
    watch.start(&app, Path::new(&meta.path));
    Ok(meta)
}

/// For each path, whether a campaign still lives there. Aligned with the
/// input so the welcome screen can flag moved or deleted folders.
#[tauri::command]
pub fn probe_campaigns(paths: Vec<String>) -> Vec<bool> {
    paths
        .iter()
        .map(|p| crate::storage::campaign_exists(p))
        .collect()
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
pub fn list_conversations(state: State<'_, AppState>) -> CommandResult<Vec<ConversationSummary>> {
    state.list_conversations().map_err(to_command_error)
}

#[tauri::command]
pub fn read_conversation(state: State<'_, AppState>, id: String) -> CommandResult<Conversation> {
    state.read_conversation(&id).map_err(to_command_error)
}

#[tauri::command]
pub fn save_conversation(
    state: State<'_, AppState>,
    conversation: Conversation,
) -> CommandResult<ConversationSummary> {
    state
        .save_conversation(conversation)
        .map_err(to_command_error)
}

#[tauri::command]
pub fn delete_conversation(state: State<'_, AppState>, id: String) -> CommandResult<()> {
    state.delete_conversation(&id).map_err(to_command_error)
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
pub fn change_element_kind(
    state: State<'_, AppState>,
    id: String,
    kind: String,
) -> CommandResult<Element> {
    state
        .change_element_kind(&id, &kind)
        .map_err(to_command_error)
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
pub fn import_element_image(
    state: State<'_, AppState>,
    element_id: String,
    source: String,
) -> CommandResult<ImportedImage> {
    state
        .import_element_image(&element_id, &source)
        .map_err(to_command_error)
}

#[tauri::command]
pub fn import_element_image_bytes(
    state: State<'_, AppState>,
    element_id: String,
    data_base64: String,
) -> CommandResult<ImportedImage> {
    let bytes = BASE64_STANDARD
        .decode(data_base64.as_bytes())
        .map_err(|e| format!("invalid image data: {e}"))?;
    state
        .import_element_image_bytes(&element_id, &bytes)
        .map_err(to_command_error)
}

#[tauri::command]
pub fn import_document(
    state: State<'_, AppState>,
    source: String,
) -> CommandResult<ImportedDocument> {
    state.import_document(&source).map_err(to_command_error)
}

/// Text of a PDF or plain-text file anywhere on disk, page by page, for the
/// import wizard. A text file is cut into pseudo-pages. Nothing is copied
/// into the campaign; `import_document` does that.
#[tauri::command]
pub async fn extract_document_text(
    source: String,
    from: Option<usize>,
    to: Option<usize>,
) -> CommandResult<PdfText> {
    let path = std::path::PathBuf::from(source);
    let meta = std::fs::metadata(&path).map_err(|e| format!("could not read the file: {e}"))?;
    if meta.len() > MAX_DOCUMENT_BYTES {
        return Err(format!(
            "document is too large ({} MB; limit is {} MB)",
            meta.len() / (1024 * 1024),
            MAX_DOCUMENT_BYTES / (1024 * 1024)
        ));
    }
    let bytes = std::fs::read(&path).map_err(|e| format!("could not read the file: {e}"))?;
    let is_text = matches!(
        path.extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_ascii_lowercase())
            .as_deref(),
        Some("txt" | "text" | "md" | "markdown")
    );
    tauri::async_runtime::spawn_blocking(move || {
        if bytes.starts_with(b"%PDF-") {
            pdf::extract(&bytes, from, to)
        } else if is_text {
            pdf::paginate_text(&String::from_utf8_lossy(&bytes), from, to)
        } else {
            Err("choose a PDF or a plain-text (.txt, .md) file".into())
        }
    })
    .await
    .map_err(|e| format!("extraction was interrupted: {e}"))?
}

/// Hard ceiling on a page-range slice sent to the model as a document: the
/// API takes 32 MB per request and base64 adds a third.
const MAX_SLICE_BYTES: usize = 22 * 1024 * 1024;

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfSlice {
    /// The page range as a PDF, base64; None when it would be too large to
    /// send, in which case the caller asks for fewer pages.
    pub data: Option<String>,
    pub bytes: usize,
}

/// A page range of a PDF anywhere on disk as a smaller PDF, for the import
/// wizard to send scanned pages to the model as pictures.
#[tauri::command]
pub async fn slice_document_pages(
    source: String,
    from: usize,
    to: usize,
) -> CommandResult<PdfSlice> {
    let path = std::path::PathBuf::from(source);
    let meta = std::fs::metadata(&path).map_err(|e| format!("could not read the file: {e}"))?;
    if meta.len() > MAX_DOCUMENT_BYTES {
        return Err(format!(
            "document is too large ({} MB; limit is {} MB)",
            meta.len() / (1024 * 1024),
            MAX_DOCUMENT_BYTES / (1024 * 1024)
        ));
    }
    let bytes = std::fs::read(&path).map_err(|e| format!("could not read the file: {e}"))?;
    tauri::async_runtime::spawn_blocking(move || {
        let out = pdf::slice(&bytes, from, to)?;
        let data = (out.len() <= MAX_SLICE_BYTES).then(|| BASE64_STANDARD.encode(&out));
        Ok(PdfSlice {
            data,
            bytes: out.len(),
        })
    })
    .await
    .map_err(|e| format!("slicing was interrupted: {e}"))?
}

/// Text of a PDF already in the campaign (`assets/docs/...`), for the
/// assistant's `read_document` tool. Pages the PDF has no text for fall back
/// to the text an import kept beside it, when there is one.
#[tauri::command]
pub async fn read_document_text(
    state: State<'_, AppState>,
    path: String,
    from: Option<usize>,
    to: Option<usize>,
) -> CommandResult<PdfText> {
    let bytes = state.read_asset(&path).map_err(to_command_error)?;
    let sidecar = state.read_document_text(&path).map_err(to_command_error)?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut text = pdf::extract(&bytes, from, to)?;
        if let Some(raw) = sidecar.filter(|_| text.empty_pages > 0) {
            let kept = pdf::sidecar_pages(&raw, text.page_count);
            for (i, page) in text.pages.iter_mut().enumerate() {
                let fallback = &kept[text.first_page - 1 + i];
                if page.is_empty() && !fallback.is_empty() {
                    *page = fallback.clone();
                    text.empty_pages -= 1;
                    text.chars += page.len();
                }
            }
        }
        Ok(text)
    })
    .await
    .map_err(|e| format!("extraction was interrupted: {e}"))?
}

/// Keeps text the import's model read off a PDF's pages beside the file, so
/// the assistant can read a scanned book later without paying for it again.
#[tauri::command]
pub fn save_document_text(
    state: State<'_, AppState>,
    path: String,
    first_page: usize,
    pages: Vec<String>,
    page_count: usize,
) -> CommandResult<String> {
    state
        .save_document_text(&path, first_page, &pages, page_count)
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
/// `player_id` previews what one paired player sees; `None` is anyone.
#[tauri::command]
pub fn list_shared_elements(
    state: State<'_, AppState>,
    player_id: Option<String>,
) -> CommandResult<Vec<ElementSummary>> {
    let registry = crate::table::players::load(&state);
    let record = player_id
        .as_deref()
        .and_then(|id| crate::table::players::find_by_id(&registry, id));
    let viewer = record.map(|p| share::Viewer {
        name: &p.name,
        player_id: Some(&p.id),
    });
    share::shared_summaries(&state, viewer.as_ref()).map_err(to_command_error)
}

#[tauri::command]
pub fn read_shared_element(
    state: State<'_, AppState>,
    id: String,
    player_id: Option<String>,
) -> CommandResult<Option<Element>> {
    let registry = crate::table::players::load(&state);
    let record = player_id
        .as_deref()
        .and_then(|pid| crate::table::players::find_by_id(&registry, pid));
    let viewer = record.map(|p| share::Viewer {
        name: &p.name,
        player_id: Some(&p.id),
    });
    share::shared_element(&state, &id, viewer.as_ref()).map_err(to_command_error)
}
