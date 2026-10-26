// Prevents a console window from opening alongside the app on Windows.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod downloads;
mod local_endpoint;
mod navigation;
mod service;
use std::sync::Mutex;
use tauri::Manager;
use tauri_plugin_dialog::DialogExt;

type LocalState = Mutex<local_endpoint::Verifications>;
fn require_library_window(window: &tauri::WebviewWindow) -> Result<(), String> {
    if window
        .url()
        .is_ok_and(|url| navigation::trusted_library(window.label(), &url))
    {
        Ok(())
    } else {
        Err("Folder dialogs require the bundled library window.".into())
    }
}
#[tauri::command]
async fn managed_endpoint(window: tauri::WebviewWindow) -> Result<serde_json::Value, String> {
    require_library_window(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        require_library_window(&window)?;
        let state = window.state::<LocalState>();
        let mut state = state
            .lock()
            .map_err(|_| "Local service verification is unavailable.")?;
        Ok(state.endpoint())
    })
    .await
    .map_err(|_| "Local service verification is unavailable.".to_string())?
}
#[tauri::command]
async fn validate_managed_selection(
    window: tauri::WebviewWindow,
    verification_id: String,
) -> Result<bool, String> {
    require_library_window(&window)?;
    if verification_id.len() > 64 {
        return Ok(false);
    }
    tauri::async_runtime::spawn_blocking(move || {
        require_library_window(&window)?;
        let current = local_endpoint::current().ok();
        let state = window.state::<LocalState>();
        let mut state = state
            .lock()
            .map_err(|_| "Local service verification is unavailable.")?;
        Ok(state.validate(&verification_id, current.as_ref()))
    })
    .await
    .map_err(|_| "Local service verification is unavailable.".to_string())?
}
#[tauri::command]
async fn choose_managed_directory(
    window: tauri::WebviewWindow,
    verification_id: String,
    purpose: String,
) -> Result<Option<String>, String> {
    require_library_window(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        require_library_window(&window)?;
        let state = window.state::<LocalState>();
        let mut state = state
            .lock()
            .map_err(|_| "Local service verification is unavailable.")?;
        let result = local_endpoint::choose_verified(
            &mut state,
            &verification_id,
            &purpose,
            || local_endpoint::current().ok(),
            || {
                require_library_window(&window)?;
                let title = if purpose == "library-folder" {
                    "Add library folder"
                } else {
                    "Add upload destination"
                };
                window
                    .dialog()
                    .file()
                    .set_parent(&window)
                    .set_title(title)
                    .blocking_pick_folder()
                    .map(|path| {
                        path.into_path()
                            .map_err(|_| "The selected folder path is unavailable.".into())
                            .and_then(|path| {
                                path.into_os_string()
                                    .into_string()
                                    .map_err(|_| "The selected folder path is unavailable.".into())
                            })
                    })
                    .transpose()
            },
        )?;
        require_library_window(&window)?;
        Ok(result)
    })
    .await
    .map_err(|_| "Local service verification is unavailable.".to_string())?
}

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

// Keep a native menu available even if a hidden webview fails to load or its
// first IPC request fails. The status page may replace it with live controls.
fn install_startup_menu(app: &tauri::App) -> tauri::Result<()> {
    use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
    let library = MenuItem::with_id(app, "startup-library", "Open library", true, None::<&str>)?;
    let status = MenuItem::with_id(
        app,
        "startup-status",
        "Server status and settings",
        true,
        None::<&str>,
    )?;
    let quit = MenuItem::with_id(app, "startup-quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[
            &library,
            &status,
            &PredefinedMenuItem::separator(app)?,
            &quit,
        ],
    )?;
    let tray = app.tray_by_id("status").ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "The configured tray icon is missing",
        )
    })?;
    tray.set_menu(Some(menu))?;
    tray.set_show_menu_on_left_click(true)?;
    Ok(())
}

fn startup_menu_action(app: &tauri::AppHandle, id: &str) {
    let label = match id {
        "startup-library" => "library",
        "startup-status" => "status",
        "startup-quit" => {
            app.exit(0);
            return;
        }
        _ => return,
    };
    if let Some(window) = app.get_webview_window(label) {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

// Rust remains the native shell: fixed OS service commands, no catalog,
// data directory, credentials, server address, or arbitrary command execution.
fn main() {
    tauri::Builder::default()
        .manage(LocalState::default())
        .on_menu_event(|app, event| startup_menu_action(app, event.id().as_ref()))
        .setup(|app| {
            install_startup_menu(app)?;
            // Build only the two configured windows, with explicit denial of popup inheritance.
            for config in app.config().app.windows.clone() {
                tauri::WebviewWindowBuilder::from_config(app, &config)?
                    .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
                    .on_download(|webview, event| {
                        if let tauri::webview::DownloadEvent::Requested { url, destination } = event
                        {
                            let Ok(document) = webview.url() else {
                                return false;
                            };
                            let Ok(directory) = webview.app_handle().path().download_dir() else {
                                return false;
                            };
                            // Wry picks a non-colliding filename. Also reject existing
                            // directory entries such as dangling symlinks before handing
                            // its native downloader a destination.
                            return downloads::allowed(
                                webview.label(),
                                &document,
                                &url,
                                destination,
                                &directory,
                            ) && destination
                                .symlink_metadata()
                                .is_err_and(|error| error.kind() == std::io::ErrorKind::NotFound);
                        }
                        true
                    })
                    .build()?;
            }
            Ok(())
        })
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
            service_stop,
            managed_endpoint,
            choose_managed_directory,
            validate_managed_selection
        ])
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .build(tauri::generate_context!())
        .expect("the tray application failed to start")
        .run(|app, event| {
            // The tray starts hidden, but reopening it from Finder/Dock must
            // reveal a window after both windows have been closed (hidden).
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen {
                has_visible_windows: false,
                ..
            } = event
            {
                if let Some(library) = app.get_webview_window("library") {
                    let _ = library.show();
                    let _ = library.set_focus();
                }
            }
            #[cfg(not(target_os = "macos"))]
            let _ = (app, event);
        });
}
