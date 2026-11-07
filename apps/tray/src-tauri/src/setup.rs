//! A local setup can download only the first-party Apple Silicon nightly.
//! Catalog initialization and LaunchAgent registration are delegated to its CLI.
use crate::service::{self, Action};
use serde::Deserialize;

const ARCHIVE: &str = "Emulation-Server-nightly-macos-arm64.tar.gz";
const ARCHIVE_ROOT: &str = "Emulation-Server-nightly-macos-arm64";
const RELEASE: &str =
    "https://api.github.com/repos/Provenance-Emu/emulator-content-server/releases/tags/nightly";
const DOWNLOAD: &str =
    "https://github.com/Provenance-Emu/emulator-content-server/releases/download/nightly";
const MAX_ARCHIVE: u64 = 512 * 1024 * 1024;

#[derive(Deserialize)]
struct Asset {
    name: String,
    size: u64,
    digest: Option<String>,
}
#[derive(Deserialize)]
struct Release {
    tag_name: String,
    draft: bool,
    assets: Vec<Asset>,
}
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

fn verify_release(release: &Release, manifest: &Manifest) -> Result<u64, String> {
    let build = &manifest.build;
    let error = || "The nightly server download could not be verified. Try again shortly.".into();
    if release.draft
        || release.tag_name != "nightly"
        || manifest.archive != ARCHIVE
        || build.platform != "macos"
        || build.arch != "arm64"
        || build.channel != "nightly"
        || !hex(&build.id, 32)
        || !hex(&build.sha, 20)
        || !hex(&manifest.sha256, 32)
    {
        return Err(error());
    }
    let mut candidates = release.assets.iter().filter(|asset| asset.name == ARCHIVE);
    let asset = candidates.next().ok_or_else(error)?;
    if candidates.next().is_some()
        || asset.size == 0
        || asset.size > MAX_ARCHIVE
        || asset.digest.as_deref() != Some(&format!("sha256:{}", manifest.sha256))
    {
        return Err(error());
    }
    Ok(asset.size)
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
        let release_file = scratch.join("release.json");
        let manifest_file = scratch.join("update.json");
        fetch(RELEASE, &release_file, 1024 * 1024)?;
        fetch(
            &format!("{DOWNLOAD}/ecs-update-macos-arm64.json"),
            &manifest_file,
            4096,
        )?;
        let release: Release = json(&release_file, 1024 * 1024)?;
        let manifest: Manifest = json(&manifest_file, 4096)?;
        let bytes = verify_release(&release, &manifest)?;

        let archive = scratch.join(ARCHIVE);
        fetch(&format!("{DOWNLOAD}/{ARCHIVE}"), &archive, bytes)?;
        let checksum = run("/usr/bin/shasum", &["-a", "256", path(&archive)?], 90)?;
        if fs::metadata(&archive)
            .map_err(|_| "Could not inspect the server archive.")?
            .len()
            != bytes
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

fn fetch(url: &str, file: &std::path::Path, max: u64) -> Result<(), String> {
    run(
        "/usr/bin/curl",
        &[
            "--disable",
            "--fail",
            "--silent",
            "--show-error",
            "--location",
            "--proto",
            "=https",
            "--proto-redir",
            "=https",
            "--connect-timeout",
            "15",
            "--max-time",
            "180",
            "--max-filesize",
            &max.to_string(),
            "--output",
            path(file)?,
            url,
        ],
        190,
    )
    .map(|_| ())
    .map_err(|_| "Could not download the verified nightly server from GitHub.".into())
}

fn json<T: serde::de::DeserializeOwned>(file: &std::path::Path, limit: u64) -> Result<T, String> {
    use std::io::Read;
    let mut bytes = Vec::new();
    std::fs::File::open(file)
        .and_then(|file| file.take(limit + 1).read_to_end(&mut bytes))
        .map_err(|_| "The server build information is unavailable.")?;
    if bytes.len() as u64 > limit {
        return Err("The server build information exceeded its size limit.".into());
    }
    serde_json::from_slice(&bytes).map_err(|_| "Invalid server build information.".into())
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
    fn requires_the_exact_nightly_platform_and_current_github_digest() {
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
        let mut release = Release {
            tag_name: "nightly".into(),
            draft: false,
            assets: vec![Asset {
                name: ARCHIVE.into(),
                size: 1024,
                digest: Some(format!("sha256:{}", manifest.sha256)),
            }],
        };
        assert_eq!(verify_release(&release, &manifest), Ok(1024));
        manifest.build.arch = "x64".into();
        assert!(verify_release(&release, &manifest).is_err());
        manifest.build.arch = "arm64".into();
        release.assets[0].digest = Some(format!("sha256:{}", "d".repeat(64)));
        assert!(verify_release(&release, &manifest).is_err());
    }
}
