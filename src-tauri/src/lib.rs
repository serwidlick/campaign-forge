mod commands;
mod identity;
mod pdf;
mod secrets;
mod storage;
mod table;
mod watcher;

use storage::AppState;
use table::TableState;
use tauri::Manager;
use watcher::FolderWatch;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::new().build());

    // The mobile app is for players only: it never picks a folder, never
    // calls the assistant and updates through the store it came from.
    #[cfg(desktop)]
    let builder = builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init());

    builder
        .setup(|_app| {
            // No credential store on a phone: the device key lives in the
            // app's private data directory instead.
            #[cfg(mobile)]
            identity::use_file_store(_app.path().app_data_dir()?);
            Ok(())
        })
        .manage(AppState::default())
        .manage(TableState::default())
        .manage(FolderWatch::default())
        .invoke_handler(tauri::generate_handler![
            commands::create_campaign,
            commands::open_campaign,
            commands::probe_campaigns,
            commands::get_campaign,
            commands::update_campaign,
            commands::list_elements,
            commands::read_element,
            commands::create_element,
            commands::save_element,
            commands::change_element_kind,
            commands::delete_element,
            commands::import_map_image,
            commands::import_map_image_bytes,
            commands::import_map_image_from_url,
            commands::read_asset,
            commands::import_element_image,
            commands::import_element_image_bytes,
            commands::import_document,
            commands::extract_document_text,
            commands::read_document_text,
            commands::slice_document_pages,
            commands::save_document_text,
            commands::search_elements,
            commands::list_conversations,
            commands::read_conversation,
            commands::save_conversation,
            commands::delete_conversation,
            commands::list_shared_elements,
            commands::read_shared_element,
            table::table_start_hosting,
            table::table_stop_hosting,
            table::table_host_status,
            table::table_spotlight,
            table::table_discover,
            table::table_discover_stop,
            table::table_join,
            table::table_leave,
            table::table_session,
            table::table_fetch_element,
            table::table_fetch_asset,
            table::table_update_sheet,
            table::table_create_note,
            table::table_update_note,
            table::table_delete_note,
            table::table_report_presence,
            table::table_next_event,
            table::table_gm_call,
            table::table_gm_asset,
            table::table_gm_import,
            identity::device_identity,
            table::table_bind_device,
            table::table_players,
            secrets::get_api_key,
            secrets::set_api_key,
            secrets::clear_api_key,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            // Quitting while hosting: players are told the table closed.
            if let tauri::RunEvent::ExitRequested { .. } = event
                && let Some(table) = app.try_state::<TableState>()
            {
                table.shutdown();
            }
        });
}
