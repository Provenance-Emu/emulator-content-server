fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "service_status",
            "service_start",
            "service_stop",
            "service_restart",
            "service_repair",
            "install_cli_tools",
            "managed_endpoint",
            "local_owner_session",
            "install_local_server",
            "reveal_local_setup_code",
            "choose_managed_directory",
            "validate_managed_selection",
            "companion_apps",
            "open_companion_app",
            "install_companion_app",
            "install_live_tray_menu",
            "set_live_tray_tooltip",
        ]),
    ))
    .expect("failed to build native command permissions");
}
