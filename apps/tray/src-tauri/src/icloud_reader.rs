//! Keeps the iCloud reader running beside the verified local server.
//!
//! The reader is a separate signed helper inside this app's bundle. It alone carries the iCloud
//! entitlement, so a problem with its provisioning profile cannot stop this app from launching.
//! This module proves to the server that it runs as the same user (the local key, exactly as
//! local owner sign-in does), receives a ticket that opens only the reader routes, and hands
//! that ticket to the helper on its standard input. The key never reaches the helper, and the
//! ticket never reaches a webview, IPC, an argument list, a log or a URL. No command is exposed
//! to JavaScript.
//! See docs/superpowers/specs/2026-11-26-native-icloud-reader-design.md.
use std::path::{Path, PathBuf};
use std::time::Duration;

const HELPER: &str = "Helpers/iCloud Reader.app/Contents/MacOS/icloud-reader";
/// Between looks for a server to attach to.
const IDLE: Duration = Duration::from_secs(20);
/// After the server said it takes no reader, or the helper ended for a reason retrying will not fix.
const LONG: Duration = Duration::from_secs(600);

/// The helper inside the bundle that holds `exe`, or `None` in a build without one.
pub(crate) fn helper_path(exe: &Path) -> Option<PathBuf> {
    // <bundle>/Contents/MacOS/<exe>
    let contents = exe.parent()?.parent()?;
    if contents.file_name()? != "Contents" {
        return None;
    }
    let helper = contents.join(HELPER);
    std::fs::symlink_metadata(&helper)
        .ok()
        .filter(|meta| meta.is_file())
        .map(|_| helper)
}

/// The ticket in the server's answer, if it has the shape the server issues.
pub(crate) fn ticket_in(body: &[u8]) -> Option<String> {
    if body.len() > 1024 {
        return None;
    }
    let value: serde_json::Value = serde_json::from_slice(body).ok()?;
    let ticket = value.get("ticket")?.as_str()?;
    (ticket.len() == 43
        && ticket
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_')))
    .then(|| ticket.to_owned())
}

/// The one line the helper reads. The origin is the verified loopback listener.
pub(crate) fn start_line(origin: &str, ticket: &str) -> String {
    format!(
        "{}\n",
        serde_json::json!({ "origin": origin, "ticket": ticket })
    )
}

/// How long to wait before trying again after the helper ended with `code`.
pub(crate) fn wait_after(code: Option<i32>) -> Duration {
    match code {
        // The ticket ended (the server restarted, or another reader attached) or the server
        // stopped answering: attach again soon.
        Some(3) | Some(4) | Some(0) => IDLE,
        // Refused at launch, crashed, or a start line it could not read. Trying again at once
        // would only repeat it.
        _ => LONG,
    }
}

enum Attach {
    Ticket(String),
    /// This server takes no reader: older, iCloud saves off, no owner yet, or a stale key.
    NotOffered,
    Unreachable,
}

#[cfg(target_os = "macos")]
async fn attach(origin: &str, key: String) -> Attach {
    let Ok(client) = reqwest::Client::builder()
        // The key goes to the loopback listener that was just verified and nowhere else.
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(5))
        .build()
    else {
        return Attach::Unreachable;
    };
    let Ok(request) = serde_json::to_vec(&serde_json::json!({ "key": key })) else {
        return Attach::Unreachable;
    };
    let Ok(reply) = client
        .post(format!("{origin}/api/v1/icloud/reader/attach"))
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .body(request)
        .send()
        .await
    else {
        return Attach::Unreachable;
    };
    if reply.status().as_u16() != 200 {
        return Attach::NotOffered;
    }
    match reply.bytes().await.ok().and_then(|body| ticket_in(&body)) {
        Some(ticket) => Attach::Ticket(ticket),
        None => Attach::NotOffered,
    }
}

/// Runs the helper until it ends. Its standard input stays open for as long as this app lives;
/// when this app quits, the pipe closes and the helper leaves with it.
#[cfg(target_os = "macos")]
fn run_helper(helper: &Path, origin: &str, ticket: &str) -> Option<i32> {
    use std::io::Write;
    use std::process::{Command, Stdio};
    let mut child = Command::new(helper)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let mut input = child.stdin.take()?;
    if input
        .write_all(start_line(origin, ticket).as_bytes())
        .is_err()
    {
        let _ = child.kill();
    }
    let status = child.wait().ok();
    drop(input);
    status.and_then(|status| status.code())
}

/// Starts the background loop. Does nothing in a build that has no helper.
#[cfg(target_os = "macos")]
pub fn supervise() {
    let Some(helper) = std::env::current_exe()
        .ok()
        .and_then(|exe| helper_path(&exe))
    else {
        return;
    };
    let _ = std::thread::Builder::new()
        .name("icloud-reader".into())
        .spawn(move || loop {
            let wait = match crate::local_owner::prepare() {
                Ok(Some((server, key))) => {
                    let origin = server.origin();
                    match tauri::async_runtime::block_on(attach(&origin, key)) {
                        Attach::Ticket(ticket) => wait_after(run_helper(&helper, &origin, &ticket)),
                        Attach::NotOffered => LONG,
                        Attach::Unreachable => IDLE,
                    }
                }
                // No managed server on this Mac right now, or it offers no key.
                _ => IDLE,
            };
            std::thread::sleep(wait);
        });
}
#[cfg(not(target_os = "macos"))]
pub fn supervise() {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_helper_is_found_only_inside_this_bundle() {
        let dir = std::env::temp_dir().join(format!("ecs-reader-{}", uuid::Uuid::new_v4()));
        let macos = dir.join("Emulation Server.app/Contents/MacOS");
        std::fs::create_dir_all(&macos).unwrap();
        let exe = macos.join("ecs-tray");
        assert_eq!(helper_path(&exe), None, "a build without the helper");
        let helper = dir.join("Emulation Server.app/Contents").join(HELPER);
        std::fs::create_dir_all(helper.parent().unwrap()).unwrap();
        std::fs::write(&helper, "generated").unwrap();
        assert_eq!(helper_path(&exe), Some(helper.clone()));
        // A development binary is not in a bundle.
        assert_eq!(helper_path(&dir.join("target/debug/ecs-tray")), None);
        // A link in the helper's place is not the helper.
        std::fs::remove_file(&helper).unwrap();
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink("/usr/bin/true", &helper).unwrap();
            assert_eq!(helper_path(&exe), None);
        }
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn only_a_well_formed_ticket_is_passed_on() {
        let ticket = "A".repeat(43);
        let body = format!(r#"{{"ticket":"{ticket}","idleSeconds":600}}"#);
        assert_eq!(ticket_in(body.as_bytes()), Some(ticket.clone()));
        for wrong in [
            "",
            "{}",
            r#"{"ticket":"short"}"#,
            r#"{"ticket":42}"#,
            &format!(r#"{{"ticket":"{}\n"}}"#, "A".repeat(42)),
            &format!(r#"{{"ticket":"{ticket}","pad":"{}"}}"#, "x".repeat(2000)),
        ] {
            assert_eq!(ticket_in(wrong.as_bytes()), None, "{wrong}");
        }
        let line = start_line("http://127.0.0.1:7878", &ticket);
        assert!(line.ends_with('\n') && line.matches('\n').count() == 1);
        let parsed: serde_json::Value = serde_json::from_str(&line).unwrap();
        assert_eq!(parsed["origin"], "http://127.0.0.1:7878");
        assert_eq!(parsed["ticket"], ticket.as_str());
    }

    #[test]
    fn a_helper_that_cannot_start_is_not_restarted_in_a_loop() {
        assert_eq!(wait_after(Some(3)), IDLE);
        assert_eq!(wait_after(Some(4)), IDLE);
        assert_eq!(wait_after(Some(2)), LONG);
        // Ended by a signal, as when macOS refuses its signature.
        assert_eq!(wait_after(None), LONG);
    }
}
