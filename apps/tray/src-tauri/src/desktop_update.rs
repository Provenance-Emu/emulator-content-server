use crate::{service::command_with_timeout, setup};
use serde::Deserialize;
use std::{
    ffi::CString,
    fs,
    os::unix::{ffi::OsStrExt, fs::DirBuilderExt},
    path::{Path, PathBuf},
    time::Duration,
};

const IMAGE: &str = "Emulation-Server-nightly-macos-arm64.dmg";
const REQUIREMENT: &str = include_str!("desktop-update.requirement");

#[derive(Deserialize)]
struct Manifest {
    sha: String,
    sha256: String,
    run: u64,
}

fn hex(value: &str, len: usize) -> bool {
    value.len() == len
        && value
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}

impl Manifest {
    fn is_update(&self, current_run: u64, current_sha: &str) -> Result<bool, String> {
        if !hex(&self.sha, 40) || !hex(&self.sha256, 64) || self.run == 0 {
            return Err("Invalid desktop update manifest.".into());
        }
        Ok(self.run > current_run && self.sha != current_sha)
    }
}

fn path(value: &Path) -> Result<&str, String> {
    value
        .to_str()
        .ok_or_else(|| "Unsupported desktop app path.".into())
}

fn run(program: &str, args: &[&str], seconds: u64, failure: &str) -> Result<String, String> {
    let reply = command_with_timeout(program, args, Duration::from_secs(seconds))
        .map_err(|_| failure.to_string())?;
    if reply.code != 0 {
        return Err(failure.into());
    }
    Ok(reply.stdout)
}

fn plist(app: &Path, key: &str) -> Result<String, String> {
    Ok(run(
        "/usr/bin/plutil",
        &[
            "-extract",
            key,
            "raw",
            "-o",
            "-",
            path(&app.join("Contents/Info.plist"))?,
        ],
        5,
        "Desktop build metadata is unavailable.",
    )?
    .trim()
    .to_owned())
}

fn trusted(app: &Path) -> Result<(), String> {
    run(
        "/usr/bin/codesign",
        &[
            "--verify",
            "--deep",
            "--strict",
            "-R",
            REQUIREMENT.trim(),
            path(app)?,
        ],
        45,
        "Desktop app failed Developer ID verification.",
    )?;
    Ok(())
}

struct Scratch(PathBuf);
impl Scratch {
    fn new(parent: &Path) -> Result<Self, String> {
        let directory = parent.join(format!(".ecs-app-update-{}", uuid::Uuid::new_v4()));
        fs::DirBuilder::new()
            .mode(0o700)
            .create(&directory)
            .map_err(|_| "Desktop updates need write access to the app's Applications folder.")?;
        Ok(Self(directory))
    }
}
impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

struct Mounted(PathBuf);
impl Drop for Mounted {
    fn drop(&mut self) {
        if let Ok(mount) = path(&self.0) {
            let _ = run(
                "/usr/bin/hdiutil",
                &["detach", mount],
                15,
                "Could not detach the update disk image.",
            );
        }
    }
}

fn swap(app: &Path, staged: &Path) -> Result<(), String> {
    let app = CString::new(app.as_os_str().as_bytes()).map_err(|_| "Invalid app path.")?;
    let staged =
        CString::new(staged.as_os_str().as_bytes()).map_err(|_| "Invalid staging path.")?;
    // Both directories are on the same filesystem. Either the complete verified
    // bundle becomes visible at the installed path, or the old bundle stays there.
    if unsafe {
        libc::renameatx_np(
            libc::AT_FDCWD,
            app.as_ptr(),
            libc::AT_FDCWD,
            staged.as_ptr(),
            libc::RENAME_SWAP,
        )
    } != 0
    {
        return Err("Could not replace the desktop app in Applications.".into());
    }
    Ok(())
}

pub fn install() -> Result<bool, String> {
    let executable =
        std::env::current_exe().map_err(|_| "Desktop executable path is unavailable.")?;
    let app = executable
        .ancestors()
        .nth(3)
        .ok_or("Desktop bundle is unavailable.")?;
    let parent = app.parent().ok_or("Desktop bundle has no parent folder.")?;
    if app.extension().and_then(|extension| extension.to_str()) != Some("app")
        || !parent.ends_with("Applications")
        || app.canonicalize().ok().as_deref() != Some(app)
    {
        return Ok(false);
    }
    let Ok(current_run) = plist(app, "ECSNightlyRun").and_then(|run| {
        run.parse::<u64>()
            .map_err(|_| "Invalid installed build number.".into())
    }) else {
        return Ok(false);
    };
    let current_sha = plist(app, "ECSNightlyCommit")?;
    if !hex(&current_sha, 40) || current_run == 0 {
        return Err("Invalid installed desktop build.".into());
    }
    trusted(app)?;
    let scratch = Scratch::new(parent)?;
    let descriptor = scratch.0.join("manifest.json");
    setup::fetch("ecs-desktop-macos-arm64.json", &descriptor, 4096)?;
    let manifest: Manifest = serde_json::from_slice(&setup::read_bounded(&descriptor, 4096)?)
        .map_err(|_| "Invalid desktop update manifest.")?;
    if !manifest.is_update(current_run, &current_sha)? {
        return Ok(false);
    }
    let image = scratch.0.join(IMAGE);
    setup::fetch(IMAGE, &image, 256 * 1024 * 1024)?;
    if run(
        "/usr/bin/shasum",
        &["-a", "256", path(&image)?],
        60,
        "Could not verify the desktop download.",
    )?
    .split_whitespace()
    .next()
        != Some(&manifest.sha256)
    {
        return Err("Desktop download checksum did not match.".into());
    }
    run(
        "/usr/sbin/spctl",
        &[
            "--assess",
            "--type",
            "open",
            "--context",
            "context:primary-signature",
            path(&image)?,
        ],
        60,
        "Desktop disk image failed Gatekeeper verification.",
    )?;
    let mount = scratch.0.join("volume");
    fs::create_dir(&mount).map_err(|_| "Could not create the update mount.")?;
    run(
        "/usr/bin/hdiutil",
        &[
            "attach",
            "-nobrowse",
            "-readonly",
            "-mountpoint",
            path(&mount)?,
            path(&image)?,
        ],
        60,
        "Could not mount the verified desktop update.",
    )?;
    let volume = Mounted(mount);
    let staged = scratch.0.join("replacement.app");
    run(
        "/usr/bin/ditto",
        &[
            path(&volume.0.join("Emulation Server.app"))?,
            path(&staged)?,
        ],
        60,
        "Could not copy the desktop update.",
    )?;
    trusted(&staged)?;
    run(
        "/usr/sbin/spctl",
        &["--assess", "--type", "execute", path(&staged)?],
        60,
        "Desktop app failed Gatekeeper verification.",
    )?;
    if plist(&staged, "ECSNightlyCommit")? != manifest.sha
        || plist(&staged, "ECSNightlyRun")? != manifest.run.to_string()
        || plist(&staged, "CFBundleExecutable")? != "ecs-tray"
        || plist(app, "ECSNightlyRun")? != current_run.to_string()
    {
        return Err("Signed desktop build did not match the update manifest.".into());
    }
    drop(volume);
    swap(app, &staged)?;
    Ok(true)
}

pub fn start(app: tauri::AppHandle) {
    std::thread::spawn(move || loop {
        match install() {
            Ok(true) => {
                app.request_restart();
                return;
            }
            Ok(false) => {}
            Err(message) => eprintln!("Desktop update: {message}"),
        }
        std::thread::sleep(Duration::from_secs(3600));
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn checks_the_build_identity_and_refuses_downgrades() {
        let mut manifest = Manifest {
            sha: "a".repeat(40),
            sha256: "b".repeat(64),
            run: 20,
        };
        assert_eq!(manifest.is_update(19, &"c".repeat(40)), Ok(true));
        assert_eq!(manifest.is_update(20, &"c".repeat(40)), Ok(false));
        assert_eq!(manifest.is_update(21, &"c".repeat(40)), Ok(false));
        assert_eq!(manifest.is_update(19, &manifest.sha), Ok(false));
        manifest.sha256 = "invalid".into();
        assert!(manifest.is_update(19, &"c".repeat(40)).is_err());
    }

    #[test]
    fn replaces_bundles_atomically() {
        let scratch = Scratch::new(&std::env::temp_dir()).unwrap();
        let app = scratch.0.join("Current.app");
        let staged = scratch.0.join("New.app");
        fs::create_dir(&app).unwrap();
        fs::create_dir(&staged).unwrap();
        fs::write(app.join("old"), []).unwrap();
        fs::write(staged.join("new"), []).unwrap();
        swap(&app, &staged).unwrap();
        assert!(app.join("new").is_file());
        assert!(staged.join("old").is_file());
        assert!(swap(&app, &scratch.0.join("missing")).is_err());
        assert!(app.join("new").is_file());
    }
}
