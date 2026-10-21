//! Downloads are collected by the shared authenticated client, then handed to
//! the webview as same-origin blobs. Never accept remote navigation as a download.
use std::path::Path;
use tauri::Url;

pub fn allowed(
    label: &str,
    document: &Url,
    url: &Url,
    destination: &Path,
    downloads: &Path,
) -> bool {
    if !crate::navigation::trusted_library(label, document) || url.scheme() != "blob" {
        return false;
    }
    let Ok(inner) = Url::parse(&url.as_str()["blob:".len()..]) else {
        return false;
    };
    let origin_matches = inner.scheme() == document.scheme()
        && inner.host_str() == document.host_str()
        && inner.port() == document.port()
        && inner.username().is_empty()
        && inner.password().is_none()
        && inner.query().is_none()
        && inner.fragment().is_none();
    let blob_id = inner
        .path()
        .strip_prefix('/')
        .and_then(|id| uuid::Uuid::parse_str(id).ok());
    let safe_name = destination
        .file_name()
        .and_then(|value| value.to_str())
        .is_some_and(|name| {
            !name.is_empty() && !name.contains(['/', '\\']) && name != "." && name != ".."
        });
    origin_matches && blob_id.is_some() && safe_name && destination.parent() == Some(downloads)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn library_blobs_can_download_only_to_a_direct_downloads_child() {
        let root = std::env::temp_dir().join("ecs-generated-downloads");
        let document = Url::parse("tauri://localhost/library.html").unwrap();
        let blob =
            Url::parse("blob:tauri://localhost/49694a84-b6d5-455c-825b-57b9f0201205").unwrap();
        assert!(allowed(
            "library",
            &document,
            &blob,
            &root.join("generated.sav"),
            &root
        ));
        for path in [
            root.join("../outside.sav"),
            root.join("nested/other.sav"),
            root.join("bad\\name.sav"),
            root.clone(),
        ] {
            assert!(!allowed("library", &document, &blob, &path, &root));
        }
    }
    #[test]
    fn remote_status_and_wrong_origin_downloads_are_rejected() {
        let root = std::env::temp_dir().join("ecs-generated-downloads");
        let document = Url::parse("tauri://localhost/library.html").unwrap();
        let blob =
            Url::parse("blob:tauri://localhost/49694a84-b6d5-455c-825b-57b9f0201205").unwrap();
        let destination = root.join("generated.sav");
        assert!(!allowed("status", &document, &blob, &destination, &root));
        assert!(!allowed(
            "library",
            &Url::parse("https://remote.example/library.html").unwrap(),
            &blob,
            &destination,
            &root
        ));
        assert!(!allowed(
            "library",
            &Url::parse("tauri://localhost/index.html").unwrap(),
            &blob,
            &destination,
            &root
        ));
        for value in [
            "https://remote.example/file",
            "file:///tmp/file",
            "blob:https://remote.example/id",
            "blob:tauri://user@localhost/id",
            "blob:tauri://localhost/id?query=1",
            "blob:tauri://localhost/id#fragment",
        ] {
            assert!(!allowed(
                "library",
                &document,
                &Url::parse(value).unwrap(),
                &destination,
                &root
            ));
        }
    }
}
