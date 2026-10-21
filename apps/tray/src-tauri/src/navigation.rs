use tauri::Url;

/// Only the two fixed bundled documents may ever occupy a privileged webview.
/// The development server is permitted only in debug builds at its fixed origin.
pub fn trusted_document(url: &Url) -> bool {
    let bundled = matches!(url.scheme(), "tauri" | "http" | "https")
        && url.host_str()
            == Some(if url.scheme() == "tauri" {
                "localhost"
            } else {
                "tauri.localhost"
            })
        && url.port().is_none();
    let development = cfg!(debug_assertions)
        && url.scheme() == "http"
        && url.host_str() == Some("localhost")
        && url.port() == Some(5174);
    (bundled || development)
        && url.username().is_empty()
        && url.password().is_none()
        && url.query().is_none()
        && matches!(url.path(), "/" | "/index.html" | "/library.html")
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn privileged_documents_are_fixed_and_bundled() {
        for url in [
            "tauri://localhost/",
            "http://tauri.localhost/index.html",
            "https://tauri.localhost/library.html",
        ] {
            assert!(trusted_document(&Url::parse(url).unwrap()), "{url}");
        }
        for url in [
            "https://server.example/ui/",
            "http://127.0.0.1:8473/ui/",
            "tauri://evil/library.html",
            "http://tauri.localhost/remote.html",
            "https://tauri.localhost:444/library.html",
            "file:///tmp/library.html",
            "blob:http://tauri.localhost/test",
            "https://user:secret@tauri.localhost/library.html",
            "http://localhost:5174/other.html",
        ] {
            assert!(!trusted_document(&Url::parse(url).unwrap()), "{url}");
        }
        assert_eq!(
            trusted_document(&Url::parse("http://localhost:5174/library.html").unwrap()),
            cfg!(debug_assertions)
        );
    }
}
