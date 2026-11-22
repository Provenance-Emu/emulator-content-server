//! Signs the bundled windows in to the verified local server as its owner.
//! The key is read here and sent here; it never reaches a webview, IPC, a log or a URL.
//! See docs/superpowers/specs/2026-11-20-local-owner-access-design.md.
use crate::local_endpoint::{self, Snapshot};
use std::path::Path;
use std::time::Duration;

const FAILED: &str =
    "This Mac could not sign in to its own server. Sign in with the owner account.";
const KEY_LENGTH: usize = 43;

/// A key file is used only if it is a plain file that this user owns and nobody else can read.
/// `None` means there is no usable key, which is normal for an older or public server.
#[cfg(unix)]
pub(crate) fn read_key(path: &Path, uid: u32) -> Option<String> {
    use std::io::Read;
    use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
    let file = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC)
        .open(path)
        .ok()?;
    let meta = file.metadata().ok()?;
    if !meta.is_file() || meta.uid() != uid || meta.mode() & 0o077 != 0 || meta.len() > 128 {
        return None;
    }
    let mut text = String::new();
    file.take(129).read_to_string(&mut text).ok()?;
    let key = text.trim_end_matches(['\n', '\r']);
    (key.len() == KEY_LENGTH
        && key
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_')))
    .then(|| key.to_owned())
}
#[cfg(not(unix))]
pub(crate) fn read_key(_: &Path, _: u32) -> Option<String> {
    None
}

/// The verified local server and this run's key, or `None` when it offers no key.
pub fn prepare() -> Result<Option<(Snapshot, String)>, String> {
    let current = local_endpoint::current()?;
    #[cfg(unix)]
    let uid = unsafe { libc::geteuid() };
    #[cfg(not(unix))]
    let uid = 0;
    let Ok(path) = current.mac_owner_key_path() else {
        return Ok(None);
    };
    Ok(read_key(&path, uid).map(|key| (current, key)))
}

/// What a typed sign-in would have returned, for the same origin the windows already use.
pub async fn exchange(origin: &str, key: String) -> Result<Option<serde_json::Value>, String> {
    let client = reqwest::Client::builder()
        // The key goes to the loopback listener that was just verified and nowhere else.
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(5))
        .build()
        .map_err(|_| FAILED)?;
    let request = serde_json::to_vec(&serde_json::json!({ "key": key })).map_err(|_| FAILED)?;
    let reply = client
        .post(format!("{origin}/api/v1/auth/local"))
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .body(request)
        .send()
        .await
        .map_err(|_| FAILED)?;
    match reply.status().as_u16() {
        200 => {}
        // No owner account yet, a server from before this existed, or a key from an earlier run.
        401 | 404 | 409 => return Ok(None),
        _ => return Err(FAILED.into()),
    }
    let bytes = reply.bytes().await.map_err(|_| FAILED)?;
    if bytes.len() > 4096 {
        return Err(FAILED.into());
    }
    let body: serde_json::Value = serde_json::from_slice(&bytes).map_err(|_| FAILED)?;
    let text = |name: &str| {
        body.get(name)
            .and_then(|value| value.as_str())
            .filter(|value| !value.is_empty() && value.len() <= 256)
            .map(str::to_owned)
    };
    match (text("token"), text("userId"), text("expiresAt")) {
        (Some(token), Some(user_id), Some(expires_at)) => Ok(Some(serde_json::json!({
            "origin": origin,
            "token": token,
            "userId": user_id,
            "expiresAt": expires_at,
        }))),
        _ => Err(FAILED.into()),
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::fs;
    use std::os::unix::fs::{symlink, PermissionsExt};

    #[test]
    fn a_key_is_read_only_from_a_private_plain_file_this_user_owns() {
        let dir = std::env::temp_dir().join(format!("ecs-owner-key-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&dir).unwrap();
        let uid = unsafe { libc::geteuid() };
        let key = "A".repeat(KEY_LENGTH);
        let file = dir.join("local-owner.key");
        let write = |text: &str, mode: u32| {
            let _ = fs::remove_file(&file);
            fs::write(&file, text).unwrap();
            fs::set_permissions(&file, fs::Permissions::from_mode(mode)).unwrap();
        };

        write(&format!("{key}\n"), 0o600);
        assert_eq!(read_key(&file, uid), Some(key.clone()));
        // Someone else's file, or one this user did not write, is not a key.
        assert_eq!(read_key(&file, uid + 1), None);
        // Readable by a group or by everyone: no longer proof of anything.
        for mode in [0o640, 0o604, 0o644, 0o660] {
            write(&key, mode);
            assert_eq!(read_key(&file, uid), None);
        }
        // Wrong shape, extra lines, or far too large.
        for text in [
            "",
            "short",
            &"A".repeat(KEY_LENGTH + 1),
            &format!("{}\nsecond line", key),
            &format!("{}!", &key[1..]),
            &"A".repeat(4096),
        ] {
            write(text, 0o600);
            assert_eq!(read_key(&file, uid), None);
        }
        // A link is never followed, whatever it points at.
        let real = dir.join("real");
        fs::write(&real, &key).unwrap();
        fs::set_permissions(&real, fs::Permissions::from_mode(0o600)).unwrap();
        fs::remove_file(&file).unwrap();
        symlink(&real, &file).unwrap();
        assert_eq!(read_key(&file, uid), None);
        assert_eq!(read_key(&dir, uid), None);
        assert_eq!(read_key(&dir.join("missing"), uid), None);
        fs::remove_dir_all(dir).unwrap();
    }
}
