use std::path::Path;

#[cfg(unix)]
mod unix {
    use crate::setup;
    use std::{
        fs::{self, File, OpenOptions},
        io::{ErrorKind, Read, Write},
        os::{
            fd::AsRawFd,
            unix::fs::{symlink, OpenOptionsExt, PermissionsExt},
        },
        path::Path,
    };

    const COMMANDS: [&str; 2] = ["ecs", "ecs-plugins"];
    const PATH_BLOCK: &str = "\n# Emulation Server CLI Tools\ncase \":$PATH:\" in\n  *\":$HOME/.local/bin:\"*) ;;\n  *) export PATH=\"$HOME/.local/bin:$PATH\" ;;\nesac\n";

    fn shim(command: &str) -> String {
        format!("#!/bin/sh\nexec \"$HOME/Library/Application Support/Emulation Server/cli/current/{command}\" \"$@\"\n")
    }

    fn check_shim(bin: &Path, command: &str) -> Result<bool, String> {
        let file = bin.join(command);
        match file.symlink_metadata() {
            Err(error) if error.kind() == ErrorKind::NotFound => Ok(false),
            Ok(meta)
                if meta.is_file()
                    && meta.permissions().mode() & 0o111 != 0
                    && fs::read_to_string(&file).is_ok_and(|value| value == shim(command)) =>
            {
                Ok(true)
            }
            _ => Err(format!(
                "{} already exists. Move it aside before installing CLI tools.",
                file.display()
            )),
        }
    }

    fn lock(root: &Path) -> Result<File, String> {
        let file = OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(false)
            .custom_flags(libc::O_NOFOLLOW)
            .mode(0o600)
            .open(root.join(".install.lock"))
            .map_err(|_| "Could not lock the CLI tools folder.")?;
        if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
            return Err("CLI tools installation is already running.".into());
        }
        Ok(file)
    }

    fn configure_path(home: &Path, shell: &str) -> std::io::Result<bool> {
        let profile = match Path::new(shell).file_name().and_then(|name| name.to_str()) {
            Some("zsh") => home.join(".zshrc"),
            Some("bash") => [".bash_profile", ".bash_login", ".profile"]
                .iter()
                .map(|name| home.join(name))
                .find(|file| file.symlink_metadata().is_ok())
                .unwrap_or_else(|| home.join(".bash_profile")),
            _ => return Ok(false),
        };
        let mut file = OpenOptions::new()
            .read(true)
            .append(true)
            .create(true)
            .mode(0o644)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
            .open(profile)?;
        let meta = file.metadata()?;
        if !meta.is_file() || meta.len() > 1024 * 1024 {
            return Ok(false);
        }
        let mut contents = String::new();
        (&mut file)
            .take(1024 * 1024)
            .read_to_string(&mut contents)?;
        if !contents.contains(PATH_BLOCK.trim_start()) {
            file.write_all(PATH_BLOCK.as_bytes())?;
        }
        Ok(true)
    }

    pub(super) fn install(home: &Path) -> Result<bool, String> {
        if !setup::available() || !home.is_absolute() {
            return Err("CLI tools installation is available on Apple Silicon Macs.".into());
        }
        let root = home.join("Library/Application Support/Emulation Server/cli");
        fs::create_dir_all(&root).map_err(|_| "Could not create the CLI tools folder.")?;
        let _lock = lock(&root)?;
        let bin = home.join(".local/bin");
        for command in COMMANDS {
            check_shim(&bin, command)?;
        }
        let current = root.join("current");
        match fs::read_link(&current) {
            Ok(path)
                if path.to_str().is_some_and(|value| {
                    value.strip_prefix("build-").is_some_and(|digest| {
                        digest.len() == 64 && digest.bytes().all(|b| b.is_ascii_hexdigit())
                    })
                }) => {}
            Err(error) if error.kind() == ErrorKind::NotFound => {}
            _ => return Err("The CLI tools location is already in use.".into()),
        }

        let download = setup::Download::new(&root)?;
        let (extracted, digest) = download.extract()?;
        let required = ["ecs", "ecs-plugins", "plugins/dist/src/main.js"];
        let has_tools = |root: &Path| {
            root.symlink_metadata().is_ok_and(|meta| meta.is_dir())
                && required.iter().all(|path| {
                    root.join(path)
                        .symlink_metadata()
                        .is_ok_and(|meta| meta.is_file())
                })
        };
        if !has_tools(&extracted) {
            return Err("This nightly is missing the CLI tools. Try again after the next nightly publishes.".into());
        }

        fs::create_dir_all(&bin).map_err(|_| "Could not create ~/.local/bin.")?;
        let version = format!("build-{digest}");
        let installed = root.join(&version);
        match installed.symlink_metadata() {
            Err(error) if error.kind() == ErrorKind::NotFound => {
                fs::rename(extracted, &installed)
                    .map_err(|_| "Could not install the verified CLI tools.")?;
            }
            Ok(_) if has_tools(&installed) => {}
            _ => return Err("An existing CLI tools build is incomplete.".into()),
        }
        let next = root.join(format!(".current-{}", uuid::Uuid::new_v4()));
        let mut created = Vec::new();
        let mut activate = || -> Result<(), String> {
            for command in COMMANDS {
                if !check_shim(&bin, command)? {
                    let file = bin.join(command);
                    let mut output = OpenOptions::new()
                        .write(true)
                        .create_new(true)
                        .mode(0o755)
                        .open(&file)
                        .map_err(|_| format!("Could not create {}.", file.display()))?;
                    created.push(file);
                    output
                        .write_all(shim(command).as_bytes())
                        .map_err(|_| format!("Could not write the {command} launcher."))?;
                }
            }
            symlink(&version, &next)
                .and_then(|()| fs::rename(&next, &current))
                .map_err(|_| "Could not activate the verified CLI tools.".into())
        };
        if let Err(error) = activate() {
            let _ = fs::remove_file(next);
            for path in created {
                let _ = fs::remove_file(path);
            }
            return Err(error);
        }
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
        Ok(configure_path(home, &shell).unwrap_or(false))
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn shell_path_setup_preserves_existing_text_and_is_idempotent() {
            let home = std::env::temp_dir().join(format!("ecs-cli-test-{}", uuid::Uuid::new_v4()));
            fs::create_dir(&home).unwrap();
            let profile = home.join(".zshrc");
            fs::write(&profile, "# my settings").unwrap();
            assert!(configure_path(&home, "/bin/zsh").unwrap());
            assert!(configure_path(&home, "/bin/zsh").unwrap());
            assert_eq!(
                fs::read_to_string(profile).unwrap(),
                format!("# my settings{PATH_BLOCK}")
            );
            let other = home.join("other");
            fs::write(&other, "user command").unwrap();
            symlink(&other, home.join(".bash_profile")).unwrap();
            assert!(configure_path(&home, "/bin/bash").is_err());
            assert_eq!(fs::read_to_string(&other).unwrap(), "user command");
            fs::remove_dir_all(home).unwrap();
        }
    }
}

pub(crate) fn install(home: &Path) -> Result<bool, String> {
    #[cfg(unix)]
    return unix::install(home);
    #[cfg(not(unix))]
    {
        let _ = home;
        Err("CLI tools installation is available on Apple Silicon Macs.".into())
    }
}
