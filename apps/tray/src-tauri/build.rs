fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "service_status",
            "service_start",
            "service_stop",
            "managed_endpoint",
            "choose_managed_directory",
            "validate_managed_selection",
        ]),
    ))
    .expect("failed to build native command permissions");
}
