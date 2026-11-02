mod commands;
mod secrets;
mod storage;

use storage::AppState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_http::init())
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            commands::create_campaign,
            commands::open_campaign,
            commands::get_campaign,
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
            secrets::get_api_key,
            secrets::set_api_key,
            secrets::clear_api_key,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
