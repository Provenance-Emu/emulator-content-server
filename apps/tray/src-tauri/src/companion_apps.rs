use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    path::{Path, PathBuf},
    sync::Mutex,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{
    menu::{Menu, MenuItem, Submenu},
    AppHandle, Emitter, Manager, WebviewWindow,
};
use tauri_plugin_opener::OpenerExt;

#[cfg(target_os = "macos")]
mod macos;

const BUNDLED: &str = include_str!("../../../../catalog/apps.json");
const SOURCE: &str = "https://raw.githubusercontent.com/Provenance-Emu/emulator-content-server/main/catalog/apps.json";
const BODY_LIMIT: usize = 64 * 1024;
const DAY: u64 = 24 * 60 * 60;
const GROUP: &str = "companion-apps";
const OPEN: &str = "companion-open:";
const GET: &str = "companion-get:";

#[derive(Deserialize)]
struct Manifest {
    schema: u32,
    apps: Vec<serde_json::Value>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct App {
    id: String,
    name: String,
    summary: String,
    bundle_ids: Vec<String>,
    links: Links,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Links {
    mac_app_store: Option<String>,
    ios_app_store: Option<String>,
    tvos_app_store: Option<String>,
    test_flight: Option<String>,
    website: Option<String>,
}

impl Links {
    fn valid(&self) -> bool {
        [
            (&self.mac_app_store, &["apps.apple.com"][..]),
            (&self.ios_app_store, &["apps.apple.com"][..]),
            (&self.tvos_app_store, &["apps.apple.com"][..]),
            (&self.test_flight, &["testflight.apple.com"][..]),
            (
                &self.website,
                &[
                    "icube-emu.com",
                    "ifly-emu.com",
                    "provenance-emu.com",
                    "jaguar.provenance-emu.com",
                ][..],
            ),
        ]
        .into_iter()
        .all(|(link, hosts)| link.as_deref().is_none_or(|link| valid_link(link, hosts)))
    }

    fn preferred(&self) -> Option<(&'static str, &str)> {
        let store = if cfg!(target_os = "macos") {
            self.mac_app_store
                .as_deref()
                .or(self.ios_app_store.as_deref())
        } else {
            self.ios_app_store
                .as_deref()
                .or(self.mac_app_store.as_deref())
        };
        store
            .map(|url| ("store", url))
            .or_else(|| self.test_flight.as_deref().map(|url| ("beta", url)))
            .or_else(|| self.website.as_deref().map(|url| ("website", url)))
    }
}

fn valid_link(value: &str, hosts: &[&str]) -> bool {
    value.len() <= 2048
        && value.starts_with("https://")
        && !value.contains('\\')
        && !value.chars().any(|c| c.is_control() || c.is_whitespace())
        && tauri::Url::parse(value).is_ok_and(|url| {
            url.scheme() == "https"
                && url.host_str().is_some_and(|host| hosts.contains(&host))
                && url.username().is_empty()
                && url.password().is_none()
                && url.port().is_none()
        })
}

fn plain_text(value: &str, max: usize) -> bool {
    !value.trim().is_empty()
        && value.chars().count() <= max
        && !value
            .chars()
            .any(|c| c.is_control() || matches!(c, '<' | '>'))
}

fn parse(body: &str) -> Option<Vec<App>> {
    if body.len() > BODY_LIMIT {
        return None;
    }
    let manifest: Manifest = serde_json::from_str(body).ok()?;
    if manifest.schema != 1 || manifest.apps.len() > 16 {
        return None;
    }
    let mut ids = HashSet::new();
    Some(
        manifest
            .apps
            .into_iter()
            .filter_map(|entry| serde_json::from_value::<App>(entry).ok())
            .filter(|app| {
                (1..=32).contains(&app.id.len())
                    && app
                        .id
                        .bytes()
                        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
                    && plain_text(&app.name, 60)
                    && plain_text(&app.summary, 160)
                    && (1..=16).contains(&app.bundle_ids.len())
                    && app.bundle_ids.iter().all(|id| {
                        (1..=128).contains(&id.len())
                            && id
                                .bytes()
                                .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'.' | b'-'))
                    })
                    && app.links.valid()
                    && ids.insert(app.id.clone())
            })
            .collect(),
    )
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
enum Kind {
    #[cfg(target_os = "macos")]
    Ipad,
    #[cfg(target_os = "macos")]
    Catalyst,
    #[cfg(target_os = "macos")]
    Mac,
}

#[derive(Debug)]
struct Installation {
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    bundle_id: String,
    path: PathBuf,
    kind: Kind,
}

#[cfg(not(target_os = "macos"))]
fn detect(_: &App) -> Option<Installation> {
    None
}
#[cfg(target_os = "macos")]
use macos::detect;

#[derive(Serialize)]
pub struct CompanionApp {
    id: String,
    installed: bool,
    kind: Option<Kind>,
    path: Option<PathBuf>,
    action: Option<Action>,
}

#[derive(Debug, PartialEq, Eq, Serialize)]
struct Action {
    kind: &'static str,
    label: String,
}

fn action(app: &App, installed: Option<&Kind>) -> Option<Action> {
    if let Some(kind) = installed {
        let suffix = match *kind {
            #[cfg(target_os = "macos")]
            Kind::Ipad => " (iPad app)",
            #[cfg(target_os = "macos")]
            Kind::Mac | Kind::Catalyst => "",
        };
        return Some(Action {
            kind: "open",
            label: format!("Open {}{suffix}", app.name),
        });
    }
    let (kind, _) = app.links.preferred()?;
    let label = match kind {
        "store" => format!("Get {} on the App Store", app.name),
        "beta" => format!("Join the {} beta", app.name),
        _ => format!("Get {}", app.name),
    };
    Some(Action { kind, label })
}

#[derive(Clone, Default, Deserialize, Serialize)]
struct Cache {
    checked_at: u64,
    etag: Option<String>,
    body: Option<String>,
}

impl Cache {
    fn read(path: &Path) -> Option<Self> {
        use std::io::Read;
        // JSON escaping can expand the embedded manifest.
        const LIMIT: u64 = 8 * BODY_LIMIT as u64;
        let mut bytes = Vec::new();
        std::fs::File::open(path)
            .ok()?
            .take(LIMIT + 1)
            .read_to_end(&mut bytes)
            .ok()?;
        if bytes.len() as u64 > LIMIT {
            return None;
        }
        let mut cache: Self = serde_json::from_slice(&bytes).ok()?;
        if cache.body.as_deref().and_then(parse).is_none() {
            cache.body = None;
            cache.etag = None;
        }
        Some(cache)
    }

    fn apps(&self) -> Vec<App> {
        self.body
            .as_deref()
            .and_then(parse)
            .unwrap_or_else(|| parse(BUNDLED).expect("valid bundled companion catalog"))
    }

    fn write(&self, path: &Path) {
        let Some(directory) = path.parent() else {
            return;
        };
        let _ = (|| -> std::io::Result<()> {
            std::fs::create_dir_all(directory)?;
            let mut file = tempfile::NamedTempFile::new_in(directory)?;
            serde_json::to_writer(&mut file, self)?;
            file.persist(path)?;
            Ok(())
        })();
    }
}

pub struct State {
    cache: Mutex<Cache>,
    path: Option<PathBuf>,
    tray: Mutex<TrayState>,
}

#[derive(Default)]
struct TrayState {
    menu: Option<Menu<tauri::Wry>>,
    tracking: bool,
    pending_menu: Option<Menu<tauri::Wry>>,
    pending_tooltip: Option<String>,
}

impl State {
    pub fn new(handle: &AppHandle) -> Self {
        let path = handle
            .path()
            .app_data_dir()
            .ok()
            .map(|dir| dir.join("companion-apps.json"));
        let cache = path.as_deref().and_then(Cache::read).unwrap_or_default();
        Self {
            cache: Mutex::new(cache),
            path,
            tray: Mutex::default(),
        }
    }

    fn apps(&self) -> Vec<App> {
        self.cache.lock().unwrap().apps()
    }
}

#[derive(Debug)]
enum Fetch {
    Modified { body: String, etag: Option<String> },
    Unchanged,
    Failed,
}

async fn fetch(etag: Option<&str>) -> Fetch {
    request(SOURCE, etag).await.unwrap_or(Fetch::Failed)
}

async fn request(source: &str, etag: Option<&str>) -> Option<Fetch> {
    use reqwest::header::{ETAG, IF_NONE_MATCH};
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .redirect(reqwest::redirect::Policy::none())
        .user_agent("Emulation Server Desktop")
        .build()
        .ok()?;
    let mut request = client.get(source);
    if let Some(etag) = etag {
        request = request.header(IF_NONE_MATCH, etag);
    }
    let mut response = request.send().await.ok()?;
    match response.status() {
        reqwest::StatusCode::NOT_MODIFIED => return Some(Fetch::Unchanged),
        reqwest::StatusCode::OK => {}
        _ => return None,
    }
    let etag = response
        .headers()
        .get(ETAG)
        .and_then(|v| v.to_str().ok())
        .filter(|v| v.len() <= 512)
        .map(str::to_owned);
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.ok()? {
        if bytes.len() + chunk.len() > BODY_LIMIT {
            return None;
        }
        bytes.extend_from_slice(&chunk);
    }
    let body = String::from_utf8(bytes).ok()?;
    parse(&body)?;
    Some(Fetch::Modified { body, etag })
}

fn apply(cache: &mut Cache, result: Fetch) -> bool {
    if let Fetch::Modified { body, etag } = result {
        cache.body = Some(body);
        cache.etag = etag;
        return true;
    }
    false
}

pub fn refresh(handle: &AppHandle) {
    let state = handle.state::<State>();
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let snapshot = {
        let mut cache = state.cache.lock().unwrap();
        if now.abs_diff(cache.checked_at) < DAY {
            return;
        }
        cache.checked_at = now;
        cache.clone()
    };
    let handle = handle.clone();
    tauri::async_runtime::spawn(async move {
        let result = fetch(snapshot.etag.as_deref()).await;
        let state = handle.state::<State>();
        let updated = {
            let mut cache = state.cache.lock().unwrap();
            if cache.checked_at != snapshot.checked_at {
                return;
            }
            let changed = apply(&mut cache, result);
            (cache.clone(), changed)
        };
        if let Some(path) = &state.path {
            updated.0.write(path);
        }
        if updated.1 {
            let _ = handle.emit_to("library", "companion-catalog-changed", ());
            let app = handle.clone();
            let _ = handle.run_on_main_thread(move || {
                let menu = {
                    let state = app.state::<State>();
                    let tray = state.tray.lock().unwrap();
                    if tray.tracking {
                        return;
                    }
                    tray.menu.clone()
                };
                if let Some(menu) = menu {
                    let _ = update_menu(&app, &menu);
                }
            });
        }
    });
}

fn rows(handle: &AppHandle) -> Vec<CompanionApp> {
    handle
        .state::<State>()
        .apps()
        .into_iter()
        .map(|app| {
            let found = detect(&app);
            let action = action(&app, found.as_ref().map(|item| &item.kind));
            let installed = found.is_some();
            let (kind, path) =
                found.map_or((None, None), |item| (Some(item.kind), Some(item.path)));
            CompanionApp {
                id: app.id,
                installed,
                kind,
                path,
                action,
            }
        })
        .collect()
}

pub fn update_menu(handle: &AppHandle, menu: &Menu<tauri::Wry>) -> tauri::Result<()> {
    let actions: Vec<_> = rows(handle)
        .into_iter()
        .filter_map(|row| row.action.map(|action| (row.id, action)))
        .collect();
    let previous = menu.get(GROUP);
    if let Some(tauri::menu::MenuItemKind::Submenu(group)) = &previous {
        let items = group.items()?;
        let matches = items.len() == actions.len()
            && items.iter().zip(&actions).all(|(item, (id, action))| {
                let tauri::menu::MenuItemKind::MenuItem(item) = item else {
                    return false;
                };
                item.id().as_ref() == menu_id(id, action)
                    && item
                        .text()
                        .is_ok_and(|text| text == menu_text(&action.label) || text == action.label)
            });
        if matches {
            return Ok(());
        }
    }
    if let Some(previous) = previous {
        menu.remove(&previous)?;
    }
    if !actions.is_empty() {
        let group = Submenu::with_id(handle, GROUP, "Apps", true)?;
        for (id, action) in actions {
            group.append(&MenuItem::with_id(
                handle,
                menu_id(&id, &action),
                menu_text(&action.label),
                true,
                None::<&str>,
            )?)?;
        }
        menu.insert(&group, menu.items()?.len().saturating_sub(1))?;
    }
    Ok(())
}

fn menu_id(id: &str, action: &Action) -> String {
    format!("{}{id}", if action.kind == "open" { OPEN } else { GET })
}

fn menu_text(label: &str) -> String {
    // Muda treats ampersands as mnemonic markers.
    label.replace('&', "&&")
}

pub fn install_menu(handle: &AppHandle, menu: Menu<tauri::Wry>) -> tauri::Result<()> {
    let tray = handle.tray_by_id("status").ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "The configured tray icon is missing",
        )
    })?;
    let state = handle.state::<State>();
    {
        let mut shell = state.tray.lock().unwrap();
        if shell.tracking {
            shell.pending_menu = Some(menu);
            return Ok(());
        }
    }
    update_menu(handle, &menu)?;
    tray.set_menu(Some(menu.clone()))?;
    #[cfg(target_os = "macos")]
    tray.with_inner_tray_icon(|tray| {
        tray.set_show_menu_on_left_click(false);
        tray.set_show_menu_on_right_click(false);
    })?;
    #[cfg(not(target_os = "macos"))]
    tray.set_show_menu_on_left_click(true)?;
    state.tray.lock().unwrap().menu = Some(menu);
    Ok(())
}

#[cfg(target_os = "macos")]
pub fn on_tray_click(handle: &AppHandle, event: &tauri::tray::TrayIconEvent) {
    use tauri::tray::{MouseButton, MouseButtonState, TrayIconEvent};
    if event.id().as_ref() != "status"
        || !matches!(
            event,
            TrayIconEvent::Click {
                button: MouseButton::Left | MouseButton::Right,
                // Tauri's Up/Down labels are inverted in the public documentation,
                // but the conversion preserves tray-icon's mouseDown event as Down.
                button_state: MouseButtonState::Down,
                ..
            }
        )
    {
        return;
    }
    let handle = handle.clone();
    // Leave Tauri's event callback before AppKit starts a nested event loop.
    dispatch2::DispatchQueue::main().exec_async(move || show_menu(&handle));
}

#[cfg(target_os = "macos")]
fn show_menu(handle: &AppHandle) {
    let Some(tray) = handle.tray_by_id("status") else {
        return;
    };
    let state = handle.state::<State>();
    let menu = {
        let mut shell = state.tray.lock().unwrap();
        if shell.tracking {
            return;
        }
        let Some(menu) = shell.menu.clone() else {
            return;
        };
        shell.tracking = true;
        menu
    };
    refresh(handle);
    let _ = update_menu(handle, &menu);
    // AppKit runs a nested event loop here. Defer tray setters until it closes
    // because tray-icon holds an immutable borrow of its native state.
    let _ = tray.with_inner_tray_icon(|tray| tray.show_menu());
    let (menu, tooltip) = {
        let mut shell = state.tray.lock().unwrap();
        shell.tracking = false;
        (shell.pending_menu.take(), shell.pending_tooltip.take())
    };
    if let Some(menu) = menu {
        let _ = install_menu(handle, menu);
    }
    if let Some(tooltip) = tooltip {
        let _ = tray.set_tooltip(Some(tooltip));
    }
}

fn lookup(handle: &AppHandle, id: &str) -> Result<App, String> {
    find_app(handle.state::<State>().apps(), id)
}

fn find_app(apps: Vec<App>, id: &str) -> Result<App, String> {
    apps.into_iter()
        .find(|app| app.id == id)
        .ok_or_else(|| "Unknown companion app.".into())
}

fn open(handle: &AppHandle, id: &str) -> Result<(), String> {
    let app = lookup(handle, id)?;
    let found = detect(&app).ok_or_else(|| format!("{} is no longer installed.", app.name))?;
    #[cfg(target_os = "macos")]
    return macos::open(found);
    #[cfg(not(target_os = "macos"))]
    match found.kind {}
}

fn install_link(handle: &AppHandle, id: &str) -> Result<(), String> {
    let app = lookup(handle, id)?;
    let (_, url) = app
        .links
        .preferred()
        .ok_or_else(|| "This app has no install link.".to_string())?;
    handle
        .opener()
        .open_url(url, None::<&str>)
        .map_err(|_| "Could not open the install link.".into())
}

pub fn menu_action(handle: &AppHandle, id: &str) -> Option<Result<(), String>> {
    if let Some(id) = id.strip_prefix(OPEN) {
        Some(open(handle, id))
    } else {
        id.strip_prefix(GET).map(|id| install_link(handle, id))
    }
}

#[tauri::command]
pub fn companion_apps(window: WebviewWindow) -> Result<Vec<CompanionApp>, String> {
    super::require_library_window(&window)?;
    refresh(window.app_handle());
    Ok(rows(window.app_handle()))
}

#[tauri::command]
pub async fn open_companion_app(window: WebviewWindow, id: String) -> Result<(), String> {
    super::require_library_window(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        super::require_library_window(&window)?;
        open(window.app_handle(), &id)
    })
    .await
    .map_err(|_| "Could not open the companion app.".to_string())?
}

#[tauri::command]
pub fn install_companion_app(window: WebviewWindow, id: String) -> Result<(), String> {
    super::require_library_window(&window)?;
    install_link(window.app_handle(), &id)
}

#[tauri::command]
pub fn install_live_tray_menu(
    window: WebviewWindow,
    menu_id: tauri::ResourceId,
) -> Result<(), String> {
    super::require_status_window(&window)?;
    let menu = window
        .resources_table()
        .get::<Menu<tauri::Wry>>(menu_id)
        .map_err(|error| error.to_string())?;
    install_menu(window.app_handle(), (*menu).clone()).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn set_live_tray_tooltip(window: WebviewWindow, tooltip: String) -> Result<(), String> {
    super::require_status_window(&window)?;
    let state = window.state::<State>();
    {
        let mut shell = state.tray.lock().unwrap();
        if shell.tracking {
            shell.pending_tooltip = Some(tooltip);
            return Ok(());
        }
    }
    if let Some(tray) = window.app_handle().tray_by_id("status") {
        tray.set_tooltip(Some(tooltip))
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io::{BufRead, BufReader, Write},
        net::TcpListener,
    };

    #[test]
    fn rejects_bad_manifests_and_drops_invalid_apps() {
        let bundled = parse(BUNDLED).unwrap();
        assert_eq!(bundled.len(), 4);
        let original: serde_json::Value = serde_json::from_str(BUNDLED).unwrap();
        let mut invalid = original.clone();
        invalid["schema"] = 2.into();
        assert!(parse(&invalid.to_string()).is_none());
        invalid["schema"] = 1.into();
        invalid["apps"] = vec![original["apps"][0].clone(); 17].into();
        assert!(parse(&invalid.to_string()).is_none());
        assert!(parse(&" ".repeat(BODY_LIMIT + 1)).is_none());

        for (field, value) in [
            ("/id", "INVALID_ID"),
            ("/name", "<b>iCube</b>"),
            ("/summary", "Line\nbreak"),
            ("/bundleIds/0", "app' OR true"),
            ("/links/website", "http://icube-emu.com"),
            ("/links/website", "https://icube-emu.com.evil.example"),
            ("/links/website", "https://evil.example@icube-emu.com"),
            ("/links/website", "https://icube-emu.com:8443"),
            ("/links/iosAppStore", "https://icube-emu.com/"),
        ] {
            let mut manifest = original.clone();
            *manifest["apps"][0].pointer_mut(field).unwrap() = value.into();
            let apps = parse(&manifest.to_string()).unwrap();
            assert_eq!(apps.len(), 3, "{field}: {value}");
            assert!(!apps.iter().any(|app| app.id == "icube"));
        }
    }

    #[test]
    fn chooses_actions_and_omits_apps_without_one() {
        let mut app = parse(BUNDLED).unwrap().remove(0);
        assert_eq!(action(&app, None).unwrap().label, "Get iCube");
        app.links.test_flight = Some("https://testflight.apple.com/join/example".into());
        assert_eq!(action(&app, None).unwrap().label, "Join the iCube beta");
        app.links.ios_app_store = Some("https://apps.apple.com/app/id123".into());
        app.links.mac_app_store = Some("https://apps.apple.com/app/id456".into());
        let target = if cfg!(target_os = "macos") {
            "id456"
        } else {
            "id123"
        };
        assert!(app.links.preferred().unwrap().1.ends_with(target));
        assert_eq!(
            action(&app, None).unwrap().label,
            "Get iCube on the App Store"
        );
        #[cfg(target_os = "macos")]
        {
            assert_eq!(
                action(&app, Some(&Kind::Ipad)).unwrap().label,
                "Open iCube (iPad app)"
            );
            assert_eq!(action(&app, Some(&Kind::Mac)).unwrap().label, "Open iCube");
        }
        app.links = serde_json::from_str("{}").unwrap();
        assert!(action(&app, None).is_none());
        assert!(find_app(vec![app], "org.other.app").is_err());
    }

    fn respond(response: String) -> (String, std::thread::JoinHandle<String>) {
        let socket = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", socket.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            let (mut client, _) = socket.accept().unwrap();
            client
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut reader = BufReader::new(&client);
            let mut headers = String::new();
            loop {
                let mut line = String::new();
                reader.read_line(&mut line).unwrap();
                if line == "\r\n" || line.is_empty() {
                    break;
                }
                headers.push_str(&line);
            }
            let _ = client.write_all(response.as_bytes());
            headers
        });
        (url, server)
    }

    #[test]
    fn fetches_conditionally_and_falls_back_to_disk_then_bundle() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("cache.json");
        let mut cache = Cache::read(&path).unwrap_or_default();
        assert!(!apply(&mut cache, Fetch::Failed));
        assert_eq!(cache.apps()[0].name, "iCube");

        let fresh = BUNDLED.replace("\"iCube\"", "\"Updated iCube\"");
        let (url, server) = respond(format!(
            "HTTP/1.1 200 OK\r\nETag: \"v1\"\r\nContent-Length: {}\r\n\r\n{fresh}",
            fresh.len()
        ));
        let result = tauri::async_runtime::block_on(request(&url, None)).unwrap();
        assert!(apply(&mut cache, result));
        assert!(server
            .join()
            .unwrap()
            .contains("user-agent: Emulation Server Desktop"));
        cache.write(&path);
        let mut cache = Cache::read(&path).unwrap();
        assert_eq!(cache.apps()[0].name, "Updated iCube");

        let (url, server) = respond("HTTP/1.1 304 Not Modified\r\n\r\n".into());
        let result = tauri::async_runtime::block_on(request(&url, cache.etag.as_deref())).unwrap();
        assert!(matches!(result, Fetch::Unchanged));
        assert!(!apply(&mut cache, result));
        assert!(server.join().unwrap().contains("if-none-match: \"v1\""));
        assert!(!apply(&mut cache, Fetch::Failed));
        assert_eq!(cache.apps()[0].name, "Updated iCube");
    }

    #[test]
    fn rejects_oversized_chunked_downloads() {
        let body = " ".repeat(BODY_LIMIT + 1);
        let (url, server) = respond(format!(
            "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n{:x}\r\n{body}\r\n0\r\n\r\n",
            body.len()
        ));
        assert!(tauri::async_runtime::block_on(request(&url, None)).is_none());
        server.join().unwrap();
    }
}
