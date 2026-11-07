//! A local setup can download only the first-party Apple Silicon nightly.
//! Catalog initialization and LaunchAgent registration are delegated to its CLI.
use crate::service::{self, Action};
use serde::Deserialize;

const ARCHIVE: &str = "Emulation-Server-nightly-macos-arm64.tar.gz";
const ARCHIVE_ROOT: &str = "Emulation-Server-nightly-macos-arm64";
const DOWNLOAD: &str =
    "https://github.com/Provenance-Emu/emulator-content-server/releases/download/nightly";
const MAX_ARCHIVE: u64 = 512 * 1024 * 1024;

#[derive(Deserialize, PartialEq, Eq)]
struct Build {
    id: String,
    sha: String,
    platform: String,
    arch: String,
    channel: String,
}
#[derive(Deserialize)]
struct Manifest {
    build: Build,
    archive: String,
    sha256: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Setup {
    setup_code: String,
}

fn hex(value: &str, bytes: usize) -> bool {
    value.len() == bytes * 2
        && value
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}

fn verify_release(checksum: &str, manifest: &Manifest) -> Result<(), String> {
    let build = &manifest.build;
    let mut fields = checksum.split_whitespace();
    if manifest.archive != ARCHIVE
        || build.platform != "macos"
        || build.arch != "arm64"
        || build.channel != "nightly"
        || !hex(&build.id, 32)
        || !hex(&build.sha, 20)
        || !hex(&manifest.sha256, 32)
        || fields.next() != Some(&manifest.sha256)
        || fields.next() != Some(ARCHIVE)
        || fields.next().is_some()
    {
        return Err(
            "The nightly manifest and release checksum did not agree. Try again shortly.".into(),
        );
    }
    Ok(())
}

pub fn available() -> bool {
    cfg!(all(target_os = "macos", target_arch = "aarch64"))
}

pub fn install(home: &std::path::Path) -> Result<String, String> {
    use std::{fs, time::Duration};

    if !available() || !home.is_absolute() {
        return Err("Local setup is available on Apple Silicon Macs.".into());
    }
    if service::execute(Action::Status)? != "absent" {
        return Err(
            "A local service is already installed. Start it or use the local connection.".into(),
        );
    }
    // A default-port listener may already belong to an independently managed process.
    if std::net::TcpListener::bind(("127.0.0.1", 8473)).is_err() {
        return Err(
            "Port 8473 is already in use. Connect to that server or choose its address.".into(),
        );
    }
    let support = home.join("Library/Application Support/Emulation Server");
    let launchers = support.join("launchers");
    fs::create_dir_all(&launchers)
        .map_err(|_| "Could not create the server installation folder.")?;
    let download = Download::new(&launchers)?;
    let (extracted, _) = download.extract()?;
    let launcher = launchers.join(format!("desktop-nightly-{}", uuid::Uuid::new_v4()));
    let runtime = launcher.join("runtime/node");
    let cli = launcher.join("server/dist/src/supervise.js");
    let data = support.join("data");
    let args = [
        path(&cli)?,
        "service",
        "setup-local",
        "--data",
        path(&data)?,
        "--host",
        "127.0.0.1",
        "--port",
        "8473",
    ];
    let program = path(&runtime)?;
    fs::rename(extracted, &launcher).map_err(|_| "Could not install the verified server.")?;
    let installed = match service::command_with_timeout(program, &args, Duration::from_secs(90)) {
        Ok(result) if result.code == 0 => result,
        _ => {
            if service::execute(Action::Status).is_ok_and(|status| status == "absent") {
                let _ = fs::remove_dir_all(launcher);
            }
            return Err("The verified server could not register its login service. Try again or connect to an existing server.".into());
        }
    };
    let setup: Setup = serde_json::from_str(&installed.stdout)
        .map_err(|_| "The local service did not return a setup code.")?;
    if setup.setup_code.len() != 43
        || !setup
            .setup_code
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_'))
    {
        return Err("The local service returned an invalid setup code.".into());
    }
    Ok(setup.setup_code)
}

pub(crate) struct Download(std::path::PathBuf);

impl Download {
    pub(crate) fn new(parent: &std::path::Path) -> Result<Self, String> {
        let scratch = parent.join(format!(".download-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&scratch).map_err(|_| "Could not stage the server download.")?;
        Ok(Self(scratch))
    }

    pub(crate) fn extract(&self) -> Result<(std::path::PathBuf, String), String> {
        use std::fs;
        let scratch = &self.0;
        let manifest_file = scratch.join("update.json");
        let checksum_file = scratch.join("checksums.txt");
        // Direct release downloads work without consuming the GitHub API quota.
        fetch("ecs-update-macos-arm64.json", &manifest_file, 4096)?;
        fetch("SHA256SUMS-server-macos-arm64.txt", &checksum_file, 4096)?;
        let manifest: Manifest = json(&manifest_file, 4096)?;
        let checksum = String::from_utf8(read_bounded(&checksum_file, 4096)?)
            .map_err(|_| "Invalid nightly checksum file.")?;
        verify_release(&checksum, &manifest)?;

        let archive = scratch.join(ARCHIVE);
        fetch(ARCHIVE, &archive, MAX_ARCHIVE)?;
        let checksum = run("/usr/bin/shasum", &["-a", "256", path(&archive)?], 90)?;
        if fs::metadata(&archive)
            .map_err(|_| "Could not inspect the server archive.")?
            .len()
            > MAX_ARCHIVE
            || checksum.split_whitespace().next() != Some(&manifest.sha256)
        {
            return Err("The downloaded server archive did not match its checksum.".into());
        }
        run(
            "/usr/bin/tar",
            &["-xzf", path(&archive)?, "-C", path(scratch)?],
            120,
        )?;
        let extracted = scratch.join(ARCHIVE_ROOT);
        if !extracted.symlink_metadata().is_ok_and(|m| m.is_dir())
            || !["runtime/node", "server/dist/src/supervise.js"]
                .iter()
                .all(|file| {
                    extracted
                        .join(file)
                        .symlink_metadata()
                        .is_ok_and(|m| m.is_file())
                })
            || json::<Build>(&extracted.join("BUILD.json"), 4096)? != manifest.build
        {
            return Err("The extracted server build did not match the verified download.".into());
        }
        Ok((extracted, manifest.sha256))
    }
}

impl Drop for Download {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn path(path: &std::path::Path) -> Result<&str, String> {
    path.to_str()
        .ok_or_else(|| "The installation path cannot be represented.".into())
}

fn fetch(asset: &str, file: &std::path::Path, max: u64) -> Result<(), String> {
    let result = service::command_with_timeout(
        "/usr/bin/curl",
        &[
            "--disable",
            "--fail",
            "--silent",
            "--location",
            "--proto",
            "=https",
            "--proto-redir",
            "=https",
            "--connect-timeout",
            "15",
            "--max-time",
            "180",
            "--retry",
            "2",
            "--retry-max-time",
            "180",
            "--max-filesize",
            &max.to_string(),
            "--output",
            path(file)?,
            "--write-out",
            "%{http_code}",
            &format!("{DOWNLOAD}/{asset}"),
        ],
        std::time::Duration::from_secs(190),
    )
    .map_err(|_| format!("Could not download {asset} from GitHub."))?;
    if result.code != 0 {
        let status = result.stdout.trim();
        return Err(
            if status.len() == 3
                && status.starts_with(['4', '5'])
                && status.bytes().all(|b| b.is_ascii_digit())
            {
                format!("GitHub returned HTTP {status} when downloading {asset}.")
            } else {
                format!("Could not download {asset} from GitHub.")
            },
        );
    }
    Ok(())
}

fn read_bounded(file: &std::path::Path, limit: u64) -> Result<Vec<u8>, String> {
    use std::io::Read;
    let mut bytes = Vec::new();
    std::fs::File::open(file)
        .and_then(|file| file.take(limit + 1).read_to_end(&mut bytes))
        .map_err(|_| "The server build information is unavailable.")?;
    if bytes.len() as u64 > limit {
        return Err("The server build information exceeded its size limit.".into());
    }
    Ok(bytes)
}

fn json<T: serde::de::DeserializeOwned>(file: &std::path::Path, limit: u64) -> Result<T, String> {
    serde_json::from_slice(&read_bounded(file, limit)?)
        .map_err(|_| "Invalid server build information.".into())
}

fn run(program: &str, args: &[&str], seconds: u64) -> Result<String, String> {
    let result =
        service::command_with_timeout(program, args, std::time::Duration::from_secs(seconds))?;
    if result.code != 0 {
        return Err("Could not verify or extract the server package.".into());
    }
    Ok(result.stdout)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn requires_the_exact_nightly_platform_and_matching_release_checksum() {
        let mut manifest = Manifest {
            build: Build {
                id: "a".repeat(64),
                sha: "b".repeat(40),
                platform: "macos".into(),
                arch: "arm64".into(),
                channel: "nightly".into(),
            },
            archive: ARCHIVE.into(),
            sha256: "c".repeat(64),
        };
        let checksum = format!("{}  {ARCHIVE}\n", manifest.sha256);
        assert_eq!(verify_release(&checksum, &manifest), Ok(()));
        assert!(verify_release(&format!("{checksum}{checksum}"), &manifest).is_err());
        assert!(verify_release(&checksum.replace(ARCHIVE, "other.tar.gz"), &manifest).is_err());
        manifest.build.arch = "x64".into();
        assert!(verify_release(&checksum, &manifest).is_err());
        manifest.build.arch = "arm64".into();
        manifest.sha256 = "d".repeat(64);
        assert!(verify_release(&checksum, &manifest).is_err());
    }
}
