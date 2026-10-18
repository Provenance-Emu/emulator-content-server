// Prevents a console window from opening alongside the app on Windows.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod service;

async fn service_command(action: service::Action) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || service::execute(action))
        .await
        .map_err(|_| "The local service command failed.".to_string())?
}

#[tauri::command]
async fn service_status() -> Result<String, String> {
    service_command(service::Action::Status).await
}

#[tauri::command]
async fn service_start() -> Result<String, String> {
    service_command(service::Action::Start).await
}

#[tauri::command]
async fn service_stop() -> Result<String, String> {
    service_command(service::Action::Stop).await
}

// Rust remains the native shell: fixed OS service commands, no catalog,
// data directory, credentials, server address, or arbitrary command execution.
fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            service_status,
            service_start,
            service_stop
        ])
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .run(tauri::generate_context!())
        .expect("the tray application failed to start");
}
