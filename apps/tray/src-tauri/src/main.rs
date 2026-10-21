// Prevents a console window from opening alongside the app on Windows.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod navigation;
mod service;

async fn service_command(action: service::Action) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || service::execute(action))
        .await
        .map_err(|_| "The local service command failed.".to_string())?
}

#[tauri::command]
async fn service_status(window: tauri::WebviewWindow) -> Result<String, String> {
    require_status_window(&window)?;
    service_command(service::Action::Status).await
}

#[tauri::command]
async fn service_start(window: tauri::WebviewWindow) -> Result<String, String> {
    require_status_window(&window)?;
    service_command(service::Action::Start).await
}

#[tauri::command]
async fn service_stop(window: tauri::WebviewWindow) -> Result<String, String> {
    require_status_window(&window)?;
    service_command(service::Action::Stop).await
}

fn require_status_window(window: &tauri::WebviewWindow) -> Result<(), String> {
    if window.label() == "status"
        && window
            .url()
            .is_ok_and(|url| navigation::trusted_document(&url))
    {
        Ok(())
    } else {
        Err("Local service controls require the bundled status window.".into())
    }
}

// Rust remains the native shell: fixed OS service commands, no catalog,
// data directory, credentials, server address, or arbitrary command execution.
fn main() {
    tauri::Builder::default()
        .plugin(
            tauri::plugin::Builder::<tauri::Wry>::new("trusted-navigation")
                .on_navigation(|webview, url| {
                    matches!(webview.label(), "status" | "library")
                        && navigation::trusted_document(url)
                })
                .build(),
        )
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
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
