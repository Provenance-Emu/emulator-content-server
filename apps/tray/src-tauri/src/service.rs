//! The only native bridge is to the current user's existing OS registration.
//! No server address, data directory, command, or credential comes from IPC.
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};
use std::{io::Read, thread};

#[derive(Clone, Copy)]
#[allow(dead_code)] // Other platforms are exercised by the same tests on every host.
pub enum Platform {
    Mac,
    Linux,
    Windows,
    Unsupported,
}
#[derive(Clone, Copy)]
pub enum Action {
    Status,
    Start,
    Stop,
    Restart,
}
pub struct Service {
    platform: Platform,
    uid: u32,
    home: PathBuf,
    installed: bool,
    boot_installed: bool,
    /// The login registration names a server build that is no longer on disk.
    program_missing: bool,
}
pub struct Reply {
    pub(crate) code: i32,
    pub(crate) stdout: String,
}

const MANAGER_ERROR: &str = "Could not contact or control your per-user service manager.";
const ABSENT_ERROR: &str = "Install the login service with ecs service install first.";
pub(crate) const BOOT_SERVICE: &str = "system/app.emulator-content-server";
const BOOT_PLIST: &str = "/Library/LaunchDaemons/app.emulator-content-server.plist";
const AGENT_PLIST: &str = "Library/LaunchAgents/app.emulator-content-server.plist";
const MISSING_ERROR: &str =
    "The login service points at a server build that is no longer installed. Choose Repair.";
const UNREADABLE_ERROR: &str =
    "The login registration could not be read. Remove it with ecs service uninstall, then set up the server again.";
const ADMIN_ERROR: &str = "The administrator request was cancelled or did not finish.";
const OSASCRIPT: &str = "/usr/bin/osascript";
// Fixed scripts: macOS shows its own administrator prompt, and nothing here comes from IPC.
// A boot job that is already loaded makes bootstrap fail, which the next command covers.
const BOOT_START: &str = "do shell script \"/bin/launchctl enable system/app.emulator-content-server; /bin/launchctl bootstrap system /Library/LaunchDaemons/app.emulator-content-server.plist 2>/dev/null; /bin/launchctl kickstart system/app.emulator-content-server\" with prompt \"Emulation Server wants to start its boot service.\" with administrator privileges";
const BOOT_RESTART: &str = "do shell script \"/bin/launchctl enable system/app.emulator-content-server; /bin/launchctl bootstrap system /Library/LaunchDaemons/app.emulator-content-server.plist 2>/dev/null; /bin/launchctl kickstart -k system/app.emulator-content-server\" with prompt \"Emulation Server wants to restart its boot service.\" with administrator privileges";
const BOOT_STOP: &str = "do shell script \"/bin/launchctl bootout system/app.emulator-content-server\" with prompt \"Emulation Server wants to stop its boot service until the next restart.\" with administrator privileges";
const SHOW: [&str; 6] = [
    "--user",
    "show",
    "ecs.service",
    "--property=LoadState",
    "--property=ActiveState",
    "--no-pager",
];

pub fn execute(action: Action) -> Result<String, String> {
    let platform = match std::env::consts::OS {
        "macos" => Platform::Mac,
        "linux" => Platform::Linux,
        "windows" => Platform::Windows,
        _ => Platform::Unsupported,
    };
    let uid = if matches!(platform, Platform::Mac | Platform::Linux) {
        let reply = command("/usr/bin/id", &["-u"])?;
        if reply.code != 0 {
            return Err(MANAGER_ERROR.into());
        }
        reply
            .stdout
            .trim()
            .parse::<u32>()
            .map_err(|_| MANAGER_ERROR)?
    } else {
        1
    };
    let home = PathBuf::from(std::env::var_os("HOME").unwrap_or_default());
    let installed = if matches!(platform, Platform::Mac) {
        if !home.is_absolute() {
            return Err(MANAGER_ERROR.into());
        }
        home.join(AGENT_PLIST)
            .try_exists()
            .map_err(|_| MANAGER_ERROR)?
    } else {
        true
    };
    let boot_installed = matches!(platform, Platform::Mac)
        && std::path::Path::new(BOOT_PLIST)
            .try_exists()
            .map_err(|_| MANAGER_ERROR)?;
    // An unreadable registration is not called broken; launchctl reports on it below.
    let program_missing = matches!(platform, Platform::Mac)
        && installed
        && !boot_installed
        && registration_arguments(&home.join(AGENT_PLIST))
            .is_some_and(|arguments| !launcher_present(&arguments));
    Service {
        platform,
        uid,
        home,
        installed,
        boot_installed,
        program_missing,
    }
    .run(action, &mut command)
    .map(str::to_owned)
}

impl Service {
    pub fn run(
        &self,
        action: Action,
        runner: &mut impl FnMut(&str, &[&str]) -> Result<Reply, String>,
    ) -> Result<&'static str, String> {
        if self.uid == 0 {
            return Err("Run the tray as your own user, never root.".into());
        }
        match self.platform {
            Platform::Mac => self.mac(action, runner),
            Platform::Linux => self.linux(action, runner),
            Platform::Windows => {
                if matches!(action, Action::Restart) {
                    self.run(Action::Stop, runner)?;
                    return self.run(Action::Start, runner);
                }
                let verb = match action {
                    Action::Status => "status",
                    Action::Start => "start",
                    Action::Stop => "stop",
                    Action::Restart => unreachable!("restart is stop then start"),
                };
                // This script and the verb are compiled in, never webview input.
                let script = format!("& {{ {} }} -Action {verb}", include_str!("service.ps1"));
                let reply = runner(
                    "powershell.exe",
                    &[
                        "-NoLogo",
                        "-NoProfile",
                        "-NonInteractive",
                        "-Command",
                        &script,
                    ],
                )?;
                required(&reply)?;
                let state = match reply.stdout.trim() {
                    "absent" => "absent",
                    "running" => "running",
                    "stopped" => "stopped",
                    "starting" => "starting",
                    "stopping" => "stopping",
                    _ => return Err(MANAGER_ERROR.into()),
                };
                available(state, action)
            }
            Platform::Unsupported => Err("This platform has no supported per-user service.".into()),
        }
    }

    fn mac(
        &self,
        action: Action,
        runner: &mut impl FnMut(&str, &[&str]) -> Result<Reply, String>,
    ) -> Result<&'static str, String> {
        if self.boot_installed {
            let status = |runner: &mut dyn FnMut(&str, &[&str]) -> Result<Reply, String>| {
                let reply = runner("/bin/launchctl", &["print", BOOT_SERVICE])?;
                match reply.code {
                    0 if reply.stdout.lines().any(|line| line == "\tstate = running") => {
                        Ok("boot-running")
                    }
                    0 | 113 => Ok("boot-stopped"),
                    _ => Err(MANAGER_ERROR.to_string()),
                }
            };
            let now = status(&mut *runner)?;
            let script = match (action, now) {
                (Action::Status, _)
                | (Action::Start, "boot-running")
                | (Action::Stop, "boot-stopped") => return Ok(now),
                (Action::Start, _) => BOOT_START,
                (Action::Restart, _) => BOOT_RESTART,
                (Action::Stop, _) => BOOT_STOP,
            };
            if runner(OSASCRIPT, &["-e", script])?.code != 0 {
                return Err(ADMIN_ERROR.into());
            }
            return status(&mut *runner);
        }
        if !self.installed {
            return available("absent", action);
        }
        let domain = format!("gui/{}", self.uid);
        let target = format!("{domain}/app.emulator-content-server");
        let reply = runner("/bin/launchctl", &["print", &target])?;
        let loaded = reply.code == 0;
        // launchctl's ESRCH status means the registration is currently unloaded.
        // Other failures must not turn into an invitation to start another job.
        if !loaded && reply.code != 113 {
            return Err(MANAGER_ERROR.into());
        }
        let field = |name: &str| {
            reply
                .stdout
                .lines()
                .find_map(|line| line.trim().strip_prefix(name))
        };
        let state = if loaded {
            field("state = ").ok_or(MANAGER_ERROR)?
        } else {
            "not running"
        };
        let running = state == "running";
        // "(never exited)" does not parse and is not a failure.
        let failed = loaded
            && !running
            && field("last exit code = ")
                .and_then(|code| code.parse::<i32>().ok())
                .is_some_and(|code| code != 0);
        let file = self.home.join(AGENT_PLIST);
        let file = file.to_str().ok_or(MANAGER_ERROR)?;
        let bootstrap = |runner: &mut dyn FnMut(&str, &[&str]) -> Result<Reply, String>| {
            if runner("/bin/launchctl", &["bootstrap", &domain, file])?.code == 0 {
                return Ok(());
            }
            // A registration someone disabled refuses to load until it is enabled again.
            step(&runner("/bin/launchctl", &["enable", &target])?, "enable")?;
            step(
                &runner("/bin/launchctl", &["bootstrap", &domain, file])?,
                "bootstrap",
            )
        };
        match action {
            // The CLI installs KeepAlive=true. A loaded job without a process
            // is waiting to start/restart and must still offer Stop (bootout).
            Action::Status => Ok(if running {
                "running"
            } else if self.program_missing {
                "broken"
            } else if failed {
                "failing"
            } else if loaded {
                "starting"
            } else {
                "stopped"
            }),
            Action::Start if running => Ok("running"),
            Action::Start | Action::Restart if self.program_missing => Err(MISSING_ERROR.into()),
            Action::Start => {
                if loaded {
                    step(
                        &runner("/bin/launchctl", &["kickstart", &target])?,
                        "kickstart",
                    )?;
                } else {
                    bootstrap(&mut *runner)?;
                }
                Ok("starting")
            }
            Action::Restart => {
                if loaded {
                    // -k ends the running process first; launchd then starts it again.
                    step(
                        &runner("/bin/launchctl", &["kickstart", "-k", &target])?,
                        "kickstart",
                    )?;
                } else {
                    bootstrap(&mut *runner)?;
                }
                Ok("starting")
            }
            Action::Stop => {
                if loaded {
                    step(&runner("/bin/launchctl", &["bootout", &target])?, "bootout")?;
                }
                Ok("stopped")
            }
        }
    }

    fn linux(
        &self,
        action: Action,
        runner: &mut impl FnMut(&str, &[&str]) -> Result<Reply, String>,
    ) -> Result<&'static str, String> {
        let reply = runner("systemctl", &SHOW)?;
        let load = property(&reply.stdout, "LoadState");
        if load == Some("not-found") {
            return available("absent", action);
        }
        required(&reply)?;
        if load != Some("loaded") {
            return Err(MANAGER_ERROR.into());
        }
        let state = match property(&reply.stdout, "ActiveState") {
            Some("active" | "reloading") => "running",
            Some("inactive" | "failed") => "stopped",
            Some("activating") => "starting",
            Some("deactivating") => "stopping",
            _ => return Err(MANAGER_ERROR.into()),
        };
        let (verb, next) = match action {
            Action::Status => return Ok(state),
            Action::Start if state == "running" || state == "starting" => return Ok(state),
            Action::Stop if state == "stopped" || state == "stopping" => return Ok(state),
            Action::Start => ("start", "starting"),
            Action::Stop => ("stop", "stopping"),
            Action::Restart => ("restart", "starting"),
        };
        required(&runner(
            "systemctl",
            &["--user", "--no-block", verb, "ecs.service"],
        )?)?;
        Ok(next)
    }
}

fn property<'a>(text: &'a str, key: &str) -> Option<&'a str> {
    text.lines()
        .filter_map(|line| line.split_once('='))
        .find_map(|(name, value)| (name == key).then_some(value))
}
fn available(state: &'static str, action: Action) -> Result<&'static str, String> {
    if state == "absent" && !matches!(action, Action::Status) {
        Err(ABSENT_ERROR.into())
    } else {
        Ok(state)
    }
}
/// Names the launchctl step and its exit code, never its output.
fn step(reply: &Reply, name: &str) -> Result<(), String> {
    if reply.code == 0 {
        Ok(())
    } else {
        Err(format!(
            "launchctl {name} failed (code {}). Choose Repair to register the service again.",
            reply.code
        ))
    }
}

/// The program and arguments the login registration starts, read with the system's own tool.
pub(crate) fn registration_arguments(plist: &std::path::Path) -> Option<Vec<String>> {
    let reply = command(
        "/usr/bin/plutil",
        &[
            "-extract",
            "ProgramArguments",
            "json",
            "-o",
            "-",
            plist.to_str()?,
        ],
    )
    .ok()?;
    if reply.code != 0 {
        return None;
    }
    serde_json::from_str(&reply.stdout).ok()
}

/// A registration starts `<node> <script> serve …`; both files have to be there.
pub(crate) fn launcher_present(arguments: &[String]) -> bool {
    arguments.len() >= 3
        && arguments[..2].iter().all(|file| {
            let file = std::path::Path::new(file);
            file.is_absolute() && file.is_file()
        })
}

/// What follows `serve` in a registration: the data folder and listen options to keep.
pub(crate) fn serve_options(arguments: &[String]) -> Result<&[String], String> {
    let options = match arguments {
        [_, _, verb, options @ ..] if verb == "serve" => options,
        _ => return Err(UNREADABLE_ERROR.into()),
    };
    let data = options
        .iter()
        .position(|option| option == "--data")
        .and_then(|index| options.get(index + 1));
    if data.is_some_and(|folder| std::path::Path::new(folder).is_absolute()) {
        Ok(options)
    } else {
        Err(UNREADABLE_ERROR.into())
    }
}

fn launcher_in(build: &std::path::Path) -> Option<(PathBuf, PathBuf)> {
    let node = build.join("runtime/node");
    let script = build.join("server/dist/src/supervise.js");
    (node.is_file() && script.is_file()).then_some((node, script))
}

/// The registration's own build when it is still there; otherwise the build the CLI tools
/// use, then the newest one local setup installed. `None` means nothing usable is on disk.
pub(crate) fn installed_launcher(
    support: &std::path::Path,
    arguments: &[String],
) -> Option<(PathBuf, PathBuf)> {
    if launcher_present(arguments) {
        return Some((PathBuf::from(&arguments[0]), PathBuf::from(&arguments[1])));
    }
    if let Some(found) = std::fs::canonicalize(support.join("cli/current"))
        .ok()
        .and_then(|build| launcher_in(&build))
    {
        return Some(found);
    }
    let mut builds: Vec<_> = std::fs::read_dir(support.join("launchers"))
        .ok()?
        .filter_map(Result::ok)
        .filter(|entry| {
            entry
                .file_name()
                .to_str()
                .is_some_and(|name| name.starts_with("desktop-nightly-"))
        })
        .filter_map(|entry| Some((entry.metadata().ok()?.modified().ok()?, entry.path())))
        .collect();
    builds.sort();
    builds
        .into_iter()
        .rev()
        .find_map(|(_, build)| launcher_in(&build))
}

/// Registers the login service again from a server build that is on disk, keeping its data
/// folder and listen options. With no build left, the verified nightly is downloaded first.
pub fn repair(home: &std::path::Path) -> Result<String, String> {
    if !cfg!(target_os = "macos") || !home.is_absolute() {
        return Err("Repair is available on macOS.".into());
    }
    if std::path::Path::new(BOOT_PLIST)
        .try_exists()
        .map_err(|_| MANAGER_ERROR)?
    {
        return Err("Run the installer again to repair the boot service.".into());
    }
    let plist = home.join(AGENT_PLIST);
    if !plist.try_exists().map_err(|_| MANAGER_ERROR)? {
        return Err(ABSENT_ERROR.into());
    }
    let arguments = registration_arguments(&plist).ok_or(UNREADABLE_ERROR)?;
    let options = serve_options(&arguments)?;
    let support = home.join("Library/Application Support/Emulation Server");
    let (node, script) = match installed_launcher(&support, &arguments) {
        Some(found) => found,
        None => {
            if !crate::setup::available() {
                return Err(
                    "No installed server build was found. Install the server again.".into(),
                );
            }
            let launchers = support.join("launchers");
            std::fs::create_dir_all(&launchers)
                .map_err(|_| "Could not create the server installation folder.")?;
            let (extracted, _) = crate::setup::Download::new(&launchers)?.extract()?;
            let build = launchers.join(format!("desktop-nightly-{}", uuid::Uuid::new_v4()));
            std::fs::rename(extracted, &build)
                .map_err(|_| "Could not install the verified server.")?;
            launcher_in(&build).ok_or("The downloaded server is incomplete.")?
        }
    };
    let mut args = vec![script.to_str().ok_or(MANAGER_ERROR)?, "service", "install"];
    args.extend(options.iter().map(String::as_str));
    // The server's own command rewrites the registration, so its listen rules still apply.
    let reply = command_with_timeout(
        node.to_str().ok_or(MANAGER_ERROR)?,
        &args,
        Duration::from_secs(90),
    )?;
    if reply.code != 0 {
        return Err(format!(
            "The server could not register its login service (code {}).",
            reply.code
        ));
    }
    execute(Action::Status)
}

fn required(reply: &Reply) -> Result<(), String> {
    if reply.code == 0 {
        Ok(())
    } else {
        Err(MANAGER_ERROR.into())
    }
}

pub(crate) fn command(program: &str, args: &[&str]) -> Result<Reply, String> {
    // The administrator prompt waits for a person to type a password.
    let seconds = if program == OSASCRIPT { 180 } else { 15 };
    command_with_timeout(program, args, Duration::from_secs(seconds))
}

pub(crate) fn command_with_timeout(
    program: &str,
    args: &[&str],
    timeout: Duration,
) -> Result<Reply, String> {
    let mut cmd = Command::new(program);
    cmd.args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    let mut child = cmd.spawn().map_err(|_| MANAGER_ERROR)?;
    let stdout = child.stdout.take().ok_or(MANAGER_ERROR)?;
    // Drain concurrently so launchctl's diagnostic output cannot fill a pipe.
    // Bound what is retained and never return raw output as an error message.
    let reader = thread::spawn(move || {
        let mut text = String::new();
        let _ = stdout.take(128 * 1024 + 1).read_to_string(&mut text);
        text
    });
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                return Ok(Reply {
                    code: status.code().unwrap_or(-1),
                    stdout: reader.join().map_err(|_| MANAGER_ERROR)?,
                })
            }
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(25)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("The per-user service manager did not answer in time.".into());
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;

    // Only the OS command boundary is replaced: these tests must never stop
    // the developer's actual login service.
    fn run(
        service: &Service,
        action: Action,
        replies: Vec<(&str, Vec<&str>, i32, &str)>,
    ) -> Result<&'static str, String> {
        let mut replies = VecDeque::from(replies);
        let result = service.run(action, &mut |program, args| {
            let (expected_program, expected_args, code, stdout) =
                replies.pop_front().expect("unexpected OS command");
            assert_eq!(program, expected_program);
            assert_eq!(args, expected_args);
            Ok(Reply {
                code,
                stdout: stdout.into(),
            })
        });
        assert!(replies.is_empty(), "missing OS command");
        result
    }

    fn service(platform: Platform, installed: bool) -> Service {
        Service {
            platform,
            uid: 501,
            home: "/Users/operator".into(),
            installed,
            boot_installed: false,
            program_missing: false,
        }
    }

    const TARGET: &str = "gui/501/app.emulator-content-server";
    fn print(
        code: i32,
        stdout: &'static str,
    ) -> (&'static str, Vec<&'static str>, i32, &'static str) {
        ("/bin/launchctl", vec!["print", TARGET], code, stdout)
    }
    fn boot(stdout: &'static str) -> (&'static str, Vec<&'static str>, i32, &'static str) {
        ("/bin/launchctl", vec!["print", BOOT_SERVICE], 0, stdout)
    }

    #[test]
    fn boot_service_controls_go_through_the_administrator_prompt() {
        let mut svc = service(Platform::Mac, false);
        svc.boot_installed = true;
        let running = "\tstate = running\n";
        assert_eq!(
            run(&svc, Action::Status, vec![boot(running)]).unwrap(),
            "boot-running"
        );
        // Nothing to ask an administrator for when it is already in that state.
        assert_eq!(
            run(&svc, Action::Start, vec![boot(running)]).unwrap(),
            "boot-running"
        );
        assert_eq!(
            run(&svc, Action::Stop, vec![boot("")]).unwrap(),
            "boot-stopped"
        );
        assert_eq!(
            run(
                &svc,
                Action::Start,
                vec![
                    boot(""),
                    (OSASCRIPT, vec!["-e", BOOT_START], 0, ""),
                    boot(running)
                ]
            )
            .unwrap(),
            "boot-running"
        );
        assert_eq!(
            run(
                &svc,
                Action::Restart,
                vec![
                    boot(running),
                    (OSASCRIPT, vec!["-e", BOOT_RESTART], 0, ""),
                    boot(running)
                ]
            )
            .unwrap(),
            "boot-running"
        );
        assert_eq!(
            run(
                &svc,
                Action::Stop,
                vec![
                    boot(running),
                    (OSASCRIPT, vec!["-e", BOOT_STOP], 0, ""),
                    boot("")
                ]
            )
            .unwrap(),
            "boot-stopped"
        );
        // Cancelling the prompt is an error with a plain reason, never a changed state.
        assert_eq!(
            run(
                &svc,
                Action::Stop,
                vec![boot(running), (OSASCRIPT, vec!["-e", BOOT_STOP], 1, "")]
            )
            .unwrap_err(),
            ADMIN_ERROR
        );
        for script in [BOOT_START, BOOT_RESTART, BOOT_STOP] {
            assert!(script.ends_with("with administrator privileges"));
            assert!(script.contains("system/app.emulator-content-server"));
        }
    }

    #[test]
    fn a_registration_whose_build_is_gone_is_broken_and_cannot_be_started() {
        let mut svc = service(Platform::Mac, true);
        svc.program_missing = true;
        assert_eq!(
            run(&svc, Action::Status, vec![print(113, "")]).unwrap(),
            "broken"
        );
        assert_eq!(
            run(
                &svc,
                Action::Status,
                vec![print(
                    0,
                    "\tstate = spawn scheduled\n\tlast exit code = 78\n"
                )]
            )
            .unwrap(),
            "broken"
        );
        assert_eq!(
            run(&svc, Action::Start, vec![print(113, "")]).unwrap_err(),
            MISSING_ERROR
        );
        assert_eq!(
            run(&svc, Action::Restart, vec![print(113, "")]).unwrap_err(),
            MISSING_ERROR
        );
        // It can still be unloaded so launchd stops retrying.
        assert_eq!(
            run(
                &svc,
                Action::Stop,
                vec![
                    print(0, "\tstate = spawn scheduled\n"),
                    ("/bin/launchctl", vec!["bootout", TARGET], 0, "")
                ]
            )
            .unwrap(),
            "stopped"
        );
    }

    #[test]
    fn a_job_that_keeps_exiting_is_failing_and_one_that_never_ran_is_starting() {
        let svc = service(Platform::Mac, true);
        assert_eq!(
            run(
                &svc,
                Action::Status,
                vec![print(
                    0,
                    "\tstate = spawn scheduled\n\tlast exit code = 1\n"
                )]
            )
            .unwrap(),
            "failing"
        );
        assert_eq!(
            run(
                &svc,
                Action::Status,
                vec![print(
                    0,
                    "\tstate = spawn scheduled\n\tlast exit code = (never exited)\n"
                )]
            )
            .unwrap(),
            "starting"
        );
        assert_eq!(
            run(
                &svc,
                Action::Status,
                vec![print(0, "\tstate = not running\n\tlast exit code = 0\n")]
            )
            .unwrap(),
            "starting"
        );
    }

    #[test]
    fn mac_restart_replaces_the_running_process_or_loads_the_registration() {
        let svc = service(Platform::Mac, true);
        let registration = svc.home.join(AGENT_PLIST);
        let registration = registration.to_str().unwrap();
        assert_eq!(
            run(
                &svc,
                Action::Restart,
                vec![
                    print(0, "\tstate = running\n"),
                    ("/bin/launchctl", vec!["kickstart", "-k", TARGET], 0, "")
                ]
            )
            .unwrap(),
            "starting"
        );
        assert_eq!(
            run(
                &svc,
                Action::Restart,
                vec![
                    print(113, ""),
                    (
                        "/bin/launchctl",
                        vec!["bootstrap", "gui/501", registration],
                        0,
                        ""
                    )
                ]
            )
            .unwrap(),
            "starting"
        );
    }

    #[test]
    fn a_disabled_registration_is_enabled_and_loaded_and_a_real_failure_names_its_step() {
        let svc = service(Platform::Mac, true);
        let registration = svc.home.join(AGENT_PLIST);
        let registration = registration.to_str().unwrap();
        let bootstrap = |code| {
            (
                "/bin/launchctl",
                vec!["bootstrap", "gui/501", registration],
                code,
                "private output",
            )
        };
        assert_eq!(
            run(
                &svc,
                Action::Start,
                vec![
                    print(113, ""),
                    bootstrap(5),
                    ("/bin/launchctl", vec!["enable", TARGET], 0, ""),
                    bootstrap(0)
                ]
            )
            .unwrap(),
            "starting"
        );
        let failure = run(
            &svc,
            Action::Start,
            vec![
                print(113, ""),
                bootstrap(5),
                ("/bin/launchctl", vec!["enable", TARGET], 0, ""),
                bootstrap(5),
            ],
        )
        .unwrap_err();
        assert_eq!(
            failure,
            "launchctl bootstrap failed (code 5). Choose Repair to register the service again."
        );
        assert!(!failure.contains("private output"));
    }

    #[test]
    fn repair_keeps_the_data_folder_and_listen_options_of_the_registration() {
        let arguments =
            |list: &[&str]| list.iter().map(|text| text.to_string()).collect::<Vec<_>>();
        let data_dir = std::env::temp_dir().join("Emulation Server").join("data");
        let registered = arguments(&[
            "/gone/runtime/node",
            "/gone/server/dist/src/supervise.js",
            "serve",
            "--data",
            data_dir.to_str().unwrap(),
            "--host",
            "127.0.0.1",
            "--port",
            "8473",
            "--webdav",
        ]);
        assert_eq!(serve_options(&registered).unwrap(), &registered[3..]);
        // Anything that is not `<node> <script> serve --data <absolute folder> …` is left alone.
        for other in [
            arguments(&["/bin/sh", "-c", "serve"]),
            arguments(&["/n", "/s", "serve", "--port", "8473"]),
            arguments(&["/n", "/s", "serve", "--data", "relative"]),
            arguments(&["/n", "/s", "backup", "--data", "/abs"]),
            arguments(&[]),
        ] {
            assert_eq!(serve_options(&other).unwrap_err(), UNREADABLE_ERROR);
        }
    }

    #[cfg(unix)]
    #[test]
    fn repair_prefers_the_registered_build_then_the_cli_build_then_the_newest_local_setup() {
        use std::fs;
        let root = std::env::temp_dir().join(format!("ecs-repair-test-{}", uuid::Uuid::new_v4()));
        let support = root.join("support");
        let build = |folder: &std::path::Path| {
            fs::create_dir_all(folder.join("runtime")).unwrap();
            fs::create_dir_all(folder.join("server/dist/src")).unwrap();
            fs::write(folder.join("runtime/node"), "").unwrap();
            fs::write(folder.join("server/dist/src/supervise.js"), "").unwrap();
            (
                folder.join("runtime/node"),
                folder.join("server/dist/src/supervise.js"),
            )
        };
        let gone = vec![
            root.join("gone/runtime/node").to_str().unwrap().to_string(),
            root.join("gone/supervise.js").to_str().unwrap().to_string(),
            "serve".to_string(),
        ];
        assert!(!launcher_present(&gone));
        assert_eq!(installed_launcher(&support, &gone), None);

        let old = build(&support.join("launchers/desktop-nightly-old"));
        assert_eq!(installed_launcher(&support, &gone), Some(old));
        // A build that lost its runtime is skipped, however new it is.
        fs::create_dir_all(support.join("launchers/desktop-nightly-partial/runtime")).unwrap();
        assert!(installed_launcher(&support, &gone).is_some());

        let cli = build(&support.join("cli/build-1"));
        std::os::unix::fs::symlink("build-1", support.join("cli/current")).unwrap();
        let found = installed_launcher(&support, &gone).unwrap();
        assert_eq!(
            fs::canonicalize(found.0).unwrap(),
            fs::canonicalize(cli.0).unwrap()
        );

        let own = build(&root.join("own"));
        let registered = vec![
            own.0.to_str().unwrap().to_string(),
            own.1.to_str().unwrap().to_string(),
            "serve".to_string(),
        ];
        assert!(launcher_present(&registered));
        assert_eq!(installed_launcher(&support, &registered), Some(own));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn absent_mac_registration_cannot_be_started() {
        let svc = service(Platform::Mac, false);
        assert_eq!(run(&svc, Action::Status, vec![]).unwrap(), "absent");
        assert!(run(&svc, Action::Start, vec![]).is_err());
    }

    #[test]
    fn mac_start_bootstraps_an_unloaded_registration_without_changing_it() {
        let svc = service(Platform::Mac, true);
        // Fixtures run on every host; PathBuf uses that host's separator even
        // while the fixed-command runner is simulating launchctl.
        let registration = svc
            .home
            .join("Library/LaunchAgents/app.emulator-content-server.plist");
        let registration = registration.to_str().unwrap();
        assert_eq!(
            run(
                &svc,
                Action::Start,
                vec![
                    (
                        "/bin/launchctl",
                        vec!["print", "gui/501/app.emulator-content-server"],
                        113,
                        ""
                    ),
                    (
                        "/bin/launchctl",
                        vec!["bootstrap", "gui/501", registration],
                        0,
                        ""
                    ),
                ]
            )
            .unwrap(),
            "starting"
        );
    }

    #[test]
    fn mac_stop_unloads_keepalive_instead_of_killing_the_process() {
        let svc = service(Platform::Mac, true);
        assert_eq!(
            run(
                &svc,
                Action::Stop,
                vec![
                    (
                        "/bin/launchctl",
                        vec!["print", "gui/501/app.emulator-content-server"],
                        0,
                        "service = {\n\tstate = running\n\tpid = 123\n}"
                    ),
                    (
                        "/bin/launchctl",
                        vec!["bootout", "gui/501/app.emulator-content-server"],
                        0,
                        ""
                    ),
                ]
            )
            .unwrap(),
            "stopped"
        );
    }

    #[test]
    fn mac_start_of_a_running_service_is_a_noop() {
        assert_eq!(
            run(
                &service(Platform::Mac, true),
                Action::Start,
                vec![(
                    "/bin/launchctl",
                    vec!["print", "gui/501/app.emulator-content-server"],
                    0,
                    "\tstate = running\n"
                ),]
            )
            .unwrap(),
            "running"
        );
    }

    #[test]
    fn mac_kickstarts_a_loaded_but_stopped_service() {
        assert_eq!(
            run(
                &service(Platform::Mac, true),
                Action::Start,
                vec![
                    (
                        "/bin/launchctl",
                        vec!["print", "gui/501/app.emulator-content-server"],
                        0,
                        "\tstate = not running\n"
                    ),
                    (
                        "/bin/launchctl",
                        vec!["kickstart", "gui/501/app.emulator-content-server"],
                        0,
                        ""
                    ),
                ]
            )
            .unwrap(),
            "starting"
        );
    }

    #[test]
    fn stopping_an_unloaded_mac_service_is_a_noop() {
        assert_eq!(
            run(
                &service(Platform::Mac, true),
                Action::Stop,
                vec![(
                    "/bin/launchctl",
                    vec!["print", "gui/501/app.emulator-content-server"],
                    113,
                    ""
                ),]
            )
            .unwrap(),
            "stopped"
        );
    }

    #[test]
    fn manager_failures_are_not_reported_as_stopped_or_leaked() {
        let result = run(
            &service(Platform::Mac, true),
            Action::Start,
            vec![(
                "/bin/launchctl",
                vec!["print", "gui/501/app.emulator-content-server"],
                1,
                "authorization: Bearer secret",
            )],
        );
        let error = result.unwrap_err();
        assert!(!error.contains("secret"));
        assert!(error.contains("service manager"));
    }

    const SHOW: [&str; 6] = [
        "--user",
        "show",
        "ecs.service",
        "--property=LoadState",
        "--property=ActiveState",
        "--no-pager",
    ];

    #[test]
    fn linux_reports_the_manager_state_instead_of_http_reachability() {
        for (active, expected) in [
            ("active", "running"),
            ("inactive", "stopped"),
            ("failed", "stopped"),
            ("activating", "starting"),
            ("deactivating", "stopping"),
        ] {
            let stdout = format!("LoadState=loaded\nActiveState={active}\n");
            assert_eq!(
                run(
                    &service(Platform::Linux, true),
                    Action::Status,
                    vec![("systemctl", SHOW.to_vec(), 0, &stdout),]
                )
                .unwrap(),
                expected
            );
        }
    }

    #[test]
    fn linux_start_and_stop_preserve_the_enabled_login_unit() {
        for (action, verb, before, after) in [
            (Action::Start, "start", "inactive", "starting"),
            (Action::Stop, "stop", "active", "stopping"),
        ] {
            let stdout = format!("LoadState=loaded\nActiveState={before}\n");
            assert_eq!(
                run(
                    &service(Platform::Linux, true),
                    action,
                    vec![
                        ("systemctl", SHOW.to_vec(), 0, &stdout),
                        (
                            "systemctl",
                            vec!["--user", "--no-block", verb, "ecs.service"],
                            0,
                            ""
                        ),
                    ]
                )
                .unwrap(),
                after
            );
        }
    }

    #[test]
    fn linux_missing_unit_is_absent_but_manager_errors_are_errors() {
        assert_eq!(
            run(
                &service(Platform::Linux, true),
                Action::Status,
                vec![(
                    "systemctl",
                    SHOW.to_vec(),
                    4,
                    "LoadState=not-found\nActiveState=inactive\n"
                ),]
            )
            .unwrap(),
            "absent"
        );
        assert!(run(
            &service(Platform::Linux, true),
            Action::Start,
            vec![(
                "systemctl",
                SHOW.to_vec(),
                4,
                "LoadState=not-found\nActiveState=inactive\n"
            ),]
        )
        .is_err());
        for stdout in [
            "",
            "LoadState=masked\nActiveState=inactive\n",
            "LoadState=loaded\nActiveState=unknown\n",
        ] {
            assert!(run(
                &service(Platform::Linux, true),
                Action::Status,
                vec![("systemctl", SHOW.to_vec(), 1, stdout),]
            )
            .is_err());
        }
    }

    #[test]
    fn windows_returns_only_known_states_and_hides_command_failures() {
        for (code, stdout, expected) in [
            (0, "running\r\n", Some("running")),
            (0, "stopped\r\n", Some("stopped")),
            (0, "absent\r\n", Some("absent")),
            (0, "unexpected", None),
            (1, "authorization: Bearer secret", None),
        ] {
            let result =
                service(Platform::Windows, true).run(Action::Status, &mut |program, args| {
                    assert_eq!(program, "powershell.exe");
                    assert_eq!(
                        &args[..4],
                        &["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"]
                    );
                    Ok(Reply {
                        code,
                        stdout: stdout.into(),
                    })
                });
            match expected {
                Some(state) => assert_eq!(result.unwrap(), state),
                None => assert!(!result.unwrap_err().contains("secret")),
            }
        }
    }

    #[test]
    fn a_crashing_keepalive_job_remains_stoppable() {
        assert_eq!(
            run(
                &service(Platform::Mac, true),
                Action::Status,
                vec![(
                    "/bin/launchctl",
                    vec!["print", "gui/501/app.emulator-content-server"],
                    0,
                    "state = spawn scheduled\n"
                ),]
            )
            .unwrap(),
            "starting"
        );
    }

    #[test]
    fn malformed_mac_status_is_not_reported_as_stopped() {
        assert!(run(
            &service(Platform::Mac, true),
            Action::Status,
            vec![(
                "/bin/launchctl",
                vec!["print", "gui/501/app.emulator-content-server"],
                0,
                ""
            ),]
        )
        .is_err());
    }

    #[test]
    fn root_and_unsupported_platforms_never_execute_service_commands() {
        let mut root = service(Platform::Mac, true);
        root.uid = 0;
        assert!(run(&root, Action::Start, vec![]).is_err());
        assert!(run(
            &service(Platform::Unsupported, true),
            Action::Status,
            vec![]
        )
        .is_err());
    }
}
