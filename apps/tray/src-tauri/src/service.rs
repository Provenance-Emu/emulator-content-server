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
}
pub struct Service {
    platform: Platform,
    uid: u32,
    home: PathBuf,
    installed: bool,
}
pub struct Reply {
    code: i32,
    stdout: String,
}

const MANAGER_ERROR: &str = "Could not contact or control your per-user service manager.";
const ABSENT_ERROR: &str = "Install the login service with ecs service install first.";
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
        home.join("Library/LaunchAgents/app.emulator-content-server.plist")
            .try_exists()
            .map_err(|_| MANAGER_ERROR)?
    } else {
        true
    };
    Service {
        platform,
        uid,
        home,
        installed,
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
                let verb = match action {
                    Action::Status => "status",
                    Action::Start => "start",
                    Action::Stop => "stop",
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
        let state = if loaded {
            reply
                .stdout
                .lines()
                .find_map(|line| line.trim().strip_prefix("state = "))
                .ok_or(MANAGER_ERROR)?
        } else {
            "not running"
        };
        let running = state == "running";
        match action {
            // The CLI installs KeepAlive=true. A loaded job without a process
            // is waiting to start/restart and must still offer Stop (bootout).
            Action::Status => Ok(if running {
                "running"
            } else if loaded {
                "starting"
            } else {
                "stopped"
            }),
            Action::Start if running => Ok("running"),
            Action::Start => {
                if loaded {
                    required(&runner("/bin/launchctl", &["kickstart", &target])?)?;
                } else {
                    let file = self
                        .home
                        .join("Library/LaunchAgents/app.emulator-content-server.plist");
                    let file = file.to_str().ok_or(MANAGER_ERROR)?;
                    required(&runner("/bin/launchctl", &["bootstrap", &domain, file])?)?;
                }
                Ok("starting")
            }
            Action::Stop => {
                if loaded {
                    required(&runner("/bin/launchctl", &["bootout", &target])?)?;
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
fn required(reply: &Reply) -> Result<(), String> {
    if reply.code == 0 {
        Ok(())
    } else {
        Err(MANAGER_ERROR.into())
    }
}

fn command(program: &str, args: &[&str]) -> Result<Reply, String> {
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
        let _ = stdout.take(128 * 1024).read_to_string(&mut text);
        text
    });
    let deadline = Instant::now() + Duration::from_secs(15);
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
        }
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
                        vec!["bootstrap", "gui/501",
                "/Users/operator/Library/LaunchAgents/app.emulator-content-server.plist"],
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
