use super::*;
use std::collections::VecDeque;

struct Fixture {
    replies: VecDeque<String>,
    process: ProcessIdentity,
    commands: Vec<(String, Vec<String>)>,
    process_reads: usize,
    next_process: Option<ProcessIdentity>,
}
impl Runner for Fixture {
    fn run(&mut self, program: &str, args: &[&str]) -> Result<String, String> {
        self.commands
            .push((program.into(), args.iter().map(|s| s.to_string()).collect()));
        self.replies
            .pop_front()
            .ok_or_else(|| "Tool unavailable".into())
    }
    fn process(&mut self, pid: u32) -> Result<ProcessIdentity, String> {
        assert_eq!(pid, 123);
        self.process_reads += 1;
        Ok(if self.process_reads > 1 {
            self.next_process
                .clone()
                .unwrap_or_else(|| self.process.clone())
        } else {
            self.process.clone()
        })
    }
}
const MAC: &str =
    "gui/501/app.emulator-content-server = {\n\tstate = running\n\tpid = 123\n\truns = 4\n}\n";
const SOCKET: &str = "p123\nu501\nf12\nn127.0.0.1:7878\nTST=LISTEN\n";
const LINUX: &str = "Id=ecs.service\nLoadState=loaded\nActiveState=active\nSubState=running\nMainPID=123\nInvocationID=0123456789abcdef0123456789abcdef\nExecMainStartTimestampMonotonic=12345678\n";
const SS: &str =
    "LISTEN 0 511 127.0.0.1:7878 0.0.0.0:* users:((\"node\",pid=123,fd=12)) uid:501 ino:123 sk:2";
fn fixture(replies: Vec<String>) -> Fixture {
    Fixture {
        replies: replies.into(),
        process: ProcessIdentity {
            uid: 501,
            start: "123456.123456".into(),
        },
        commands: vec![],
        process_reads: 0,
        next_process: None,
    }
}
fn mac(service: &str, sockets: &str) -> Fixture {
    fixture(vec![
        service.into(),
        sockets.into(),
        sockets.into(),
        service.into(),
    ])
}
#[test]
fn verifies_fixed_mac_service_owner_process_and_exact_listener() {
    let mut f = mac(MAC, SOCKET);
    let result = inspect(Platform::Mac, 501, &mut f).unwrap();
    assert_eq!(
        f.commands,
        vec![
            (
                "/bin/launchctl".into(),
                vec!["print".into(), "gui/501/app.emulator-content-server".into()]
            ),
            (
                "/usr/sbin/lsof".into(),
                ["-nP", "-a", "-p", "123", "-iTCP", "-sTCP:LISTEN", "-FpufnT"]
                    .map(String::from)
                    .to_vec()
            ),
            (
                "/usr/sbin/lsof".into(),
                ["-nP", "-iTCP@127.0.0.1:7878", "-sTCP:LISTEN", "-FpufnT"]
                    .map(String::from)
                    .to_vec()
            ),
            (
                "/bin/launchctl".into(),
                vec!["print".into(), "gui/501/app.emulator-content-server".into()]
            ),
        ]
    );
    assert_eq!(result.origin(), "http://127.0.0.1:7878");
    assert_eq!(result.pid, 123);
}
#[test]
fn wrong_service_pid_owner_and_ambiguous_or_nonloopback_listener_fail_closed() {
    for service in [
        MAC.replace("app.emulator-content-server", "other"),
        MAC.replace("running", "waiting"),
        MAC.replace("pid = 123", "pid = 0"),
        MAC.replace("runs = 4", "runs = nope"),
    ] {
        assert!(inspect(Platform::Mac, 501, &mut mac(&service, SOCKET)).is_err());
    }
    for socket in [
        SOCKET.replace("p123", "p999"),
        SOCKET.replace("u501", "u502"),
        SOCKET.replace("127.0.0.1", "*"),
        SOCKET.replace("7878", "0"),
        SOCKET.replace("7878", "99999"),
        format!("{SOCKET}f13\nn[::1]:7878\nTST=LISTEN\n"),
        "p123\nu501\nf12\nn127.0.0.1:7878\n".into(),
    ] {
        assert!(inspect(Platform::Mac, 501, &mut mac(MAC, &socket)).is_err());
    }
    let mut f = mac(MAC, SOCKET);
    f.process.uid = 502;
    assert!(inspect(Platform::Mac, 501, &mut f).is_err());
}
#[test]
fn missing_tools_truncated_output_and_hidden_competing_listener_fail_closed() {
    assert!(inspect(Platform::Mac, 501, &mut fixture(vec![])).is_err());
    assert!(inspect(Platform::Mac, 501, &mut mac(&"x".repeat(131073), SOCKET)).is_err());
    assert!(inspect(
        Platform::Mac,
        501,
        &mut mac("pid = 123\nstate = running", SOCKET)
    )
    .is_err());
    let mut f = mac(MAC, SOCKET);
    f.replies[2] = format!("{SOCKET}p999\nu502\nf9\nn127.0.0.1:7878\nTST=LISTEN\n");
    assert!(inspect(Platform::Mac, 501, &mut f).is_err());
}
#[test]
fn changing_service_during_inspection_fails() {
    let mut f = mac(MAC, SOCKET);
    f.replies[3] = MAC.replace("runs = 4", "runs = 5");
    assert!(inspect(Platform::Mac, 501, &mut f).is_err());
    let mut f = mac(MAC, SOCKET);
    f.next_process = Some(ProcessIdentity {
        uid: 501,
        start: "new".into(),
    });
    assert!(inspect(Platform::Mac, 501, &mut f).is_err());
}
#[test]
fn linux_requires_fixed_unit_generation_and_visible_owner_listener() {
    let mut f = fixture(vec![LINUX.into(), SS.into(), LINUX.into()]);
    assert_eq!(
        inspect(Platform::Linux, 501, &mut f).unwrap().origin(),
        "http://127.0.0.1:7878"
    );
    for output in [
        SS.replace("pid=123", "pid=999"),
        SS.replace("uid:501", "uid:502"),
        SS.replace("127.0.0.1", "0.0.0.0"),
        SS.replace("7878", "65536"),
        format!("{SS}\n{SS}"),
        format!("{SS}\nLISTEN 0 511 0.0.0.0:7878 0.0.0.0:*"),
        "LISTEN 0 511 127.0.0.1:7878 0.0.0.0:*".into(),
    ] {
        let mut f = fixture(vec![LINUX.into(), output, LINUX.into()]);
        assert!(inspect(Platform::Linux, 501, &mut f).is_err());
    }
    for service in [
        LINUX.replace("Id=ecs.service", "Id=other.service"),
        LINUX.replace("MainPID=123", "MainPID=0"),
        LINUX.replace("active", "inactive"),
        LINUX.replace(
            "InvocationID=0123456789abcdef0123456789abcdef",
            "InvocationID=",
        ),
    ] {
        let mut f = fixture(vec![service, SS.into(), LINUX.into()]);
        assert!(inspect(Platform::Linux, 501, &mut f).is_err());
    }
}
#[test]
fn unsupported_windows_and_root_never_probe() {
    for platform in [Platform::Windows, Platform::Unsupported] {
        assert!(inspect(platform, 501, &mut fixture(vec![])).is_err());
    }
    assert!(inspect(Platform::Mac, 0, &mut fixture(vec![])).is_err());
}
#[test]
fn restart_pid_reuse_and_port_changes_invalidate_ids_and_dialog_results() {
    let original = inspect(Platform::Mac, 501, &mut mac(MAC, SOCKET)).unwrap();
    for changed in [
        Snapshot {
            start: "different".into(),
            ..original.clone()
        },
        Snapshot {
            generation: "5".into(),
            ..original.clone()
        },
        Snapshot {
            listener: "127.0.0.1:8888".into(),
            ..original.clone()
        },
        Snapshot {
            uid: 502,
            ..original.clone()
        },
        Snapshot {
            pid: 999,
            ..original.clone()
        },
    ] {
        let mut state = Verifications::default();
        let id = state.bind(original.clone());
        assert!(!state.validate(&id, Some(&changed)));
        assert!(
            !state.validate(&id, Some(&original)),
            "invalidated IDs cannot revive"
        );
    }
    let mut state = Verifications::default();
    let id = state.bind(original.clone());
    let mut inspections = VecDeque::from([Some(original.clone()), None]);
    assert!(choose_verified(
        &mut state,
        &id,
        "library-folder",
        || inspections.pop_front().unwrap(),
        || Ok(Some("/Volumes/Arcade".into()))
    )
    .is_err());
}
#[test]
fn cancellation_stays_null_and_invalid_requests_never_open_a_dialog() {
    let original = inspect(Platform::Mac, 501, &mut mac(MAC, SOCKET)).unwrap();
    let mut state = Verifications::default();
    let id = state.bind(original.clone());
    assert_eq!(
        choose_verified(
            &mut state,
            &id,
            "upload-storage",
            || Some(original.clone()),
            || Ok(None)
        )
        .unwrap(),
        None
    );
    assert!(choose_verified(
        &mut state,
        &id,
        "arbitrary-purpose",
        || Some(original.clone()),
        || panic!("must not open")
    )
    .is_err());
    assert!(choose_verified(
        &mut state,
        "unknown",
        "library-folder",
        || Some(original.clone()),
        || panic!("must not open")
    )
    .is_err());
    for _ in 0..40 {
        state.bind(original.clone());
    }
    assert!(!state.validate(&id, Some(&original)), "old IDs are bounded");
}
