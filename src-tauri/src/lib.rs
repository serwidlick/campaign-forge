mod commands;
mod storage;

use storage::AppState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::new().build())
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
