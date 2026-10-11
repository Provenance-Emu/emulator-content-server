// Prevents a console window from opening alongside the app on Windows.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

/// The Rust side stays deliberately thin. The tray icon, its menu, and the
/// polling are built in TypeScript so the menu and the web interface read the
/// same client and the same components, which is the only way the two stop
/// drifting apart. This process contributes the native shell and nothing else:
/// it holds no credential, opens no database, and knows no server address.
fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .run(tauri::generate_context!())
        .expect("the tray application failed to start");
}
