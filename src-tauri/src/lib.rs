mod commands;
mod secrets;
mod storage;
mod table;

use storage::AppState;
use table::TableState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_http::init())
        .manage(AppState::default())
        .manage(TableState::default())
        .invoke_handler(tauri::generate_handler![
            commands::create_campaign,
            commands::open_campaign,
            commands::get_campaign,
            commands::update_campaign,
            commands::list_elements,
            commands::read_element,
            commands::create_element,
            commands::save_element,
            commands::delete_element,
            commands::import_map_image,
            commands::import_map_image_bytes,
            commands::import_map_image_from_url,
            commands::read_asset,
            commands::search_elements,
            commands::list_shared_elements,
            commands::read_shared_element,
            table::table_start_hosting,
            table::table_stop_hosting,
            table::table_host_status,
            table::table_discover,
            table::table_discover_stop,
            table::table_join,
            table::table_leave,
            table::table_session,
            table::table_fetch_elements,
            table::table_fetch_element,
            table::table_fetch_asset,
            table::table_wait_for_change,
            secrets::get_api_key,
            secrets::set_api_key,
            secrets::clear_api_key,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
