//! Fail-closed correlation of the fixed per-user service and its exact loopback listener.
//! No address, executable, PID, file path or command comes from IPC.
use crate::service::{self, Platform};
use std::collections::VecDeque;
use std::time::{Duration, Instant};

const UNAVAILABLE: &str =
    "Local service identity could not be verified. Use the server folder chooser.";
const MAX_OUTPUT: usize = 128 * 1024;
const LINUX_SHOW: &[&str] = &[
    "--user",
    "show",
    "ecs.service",
    "--no-pager",
    "--property=Id",
    "--property=LoadState",
    "--property=ActiveState",
    "--property=SubState",
    "--property=MainPID",
    "--property=InvocationID",
    "--property=ExecMainStartTimestampMonotonic",
];
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProcessIdentity {
    pub uid: u32,
    pub start: String,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Snapshot {
    service: String,
    uid: u32,
    pid: u32,
    start: String,
    generation: String,
    listener: String,
}
impl Snapshot {
    pub fn origin(&self) -> String {
        format!("http://{}", self.listener)
    }
}
pub trait Runner {
    fn run(&mut self, program: &str, args: &[&str]) -> Result<String, String>;
    fn process(&mut self, pid: u32) -> Result<ProcessIdentity, String>;
}
struct NativeRunner;
impl Runner for NativeRunner {
    fn run(&mut self, program: &str, args: &[&str]) -> Result<String, String> {
        let reply = service::command(program, args).map_err(|_| UNAVAILABLE)?;
        if reply.code != 0 || reply.stdout.len() > MAX_OUTPUT {
            return Err(UNAVAILABLE.into());
        }
        Ok(reply.stdout)
    }
    fn process(&mut self, pid: u32) -> Result<ProcessIdentity, String> {
        process_identity(pid)
    }
}
#[cfg(target_os = "macos")]
fn process_identity(pid: u32) -> Result<ProcessIdentity, String> {
    // Fixed OS metadata call; this struct contains identity and birth time, no argv/environment.
    let mut info = std::mem::MaybeUninit::<libc::proc_bsdinfo>::zeroed();
    let size = std::mem::size_of::<libc::proc_bsdinfo>();
    let count = unsafe {
        libc::proc_pidinfo(
            pid as i32,
            libc::PROC_PIDTBSDINFO,
            0,
            info.as_mut_ptr().cast(),
            size as i32,
        )
    };
    if count != size as i32 {
        return Err(UNAVAILABLE.into());
    }
    let info = unsafe { info.assume_init() };
    if info.pbi_pid != pid || info.pbi_uid != info.pbi_ruid || info.pbi_start_tvsec == 0 {
        return Err(UNAVAILABLE.into());
    }
    Ok(ProcessIdentity {
        uid: info.pbi_uid,
        start: format!("{}.{}", info.pbi_start_tvsec, info.pbi_start_tvusec),
    })
}
#[cfg(target_os = "linux")]
fn process_identity(pid: u32) -> Result<ProcessIdentity, String> {
    use std::io::Read;
    use std::os::unix::fs::MetadataExt;
    // Only a PID obtained from the fixed user unit can reach this fixed proc metadata path.
    let path = format!("/proc/{pid}/stat");
    let mut text = String::new();
    let file = std::fs::File::open(path).map_err(|_| UNAVAILABLE)?;
    let uid = file.metadata().map_err(|_| UNAVAILABLE)?.uid();
    file.take(8193)
        .read_to_string(&mut text)
        .map_err(|_| UNAVAILABLE)?;
    if text.len() > 8192 || !text.starts_with(&format!("{pid} (")) {
        return Err(UNAVAILABLE.into());
    }
    let fields = text.rsplit_once(')').ok_or(UNAVAILABLE)?.1;
    let start = fields.split_whitespace().nth(19).ok_or(UNAVAILABLE)?;
    positive(start)?;
    Ok(ProcessIdentity {
        uid,
        start: start.into(),
    })
}
#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn process_identity(_: u32) -> Result<ProcessIdentity, String> {
    Err(UNAVAILABLE.into())
}

pub fn current() -> Result<Snapshot, String> {
    let platform = match std::env::consts::OS {
        "macos" => Platform::Mac,
        "linux" => Platform::Linux,
        "windows" => Platform::Windows,
        _ => Platform::Unsupported,
    };
    #[cfg(unix)]
    let uid = unsafe { libc::geteuid() };
    #[cfg(not(unix))]
    let uid = 0;
    inspect(platform, uid, &mut NativeRunner)
}
fn output(runner: &mut impl Runner, program: &str, args: &[&str]) -> Result<String, String> {
    let text = runner.run(program, args).map_err(|_| UNAVAILABLE)?;
    if text.len() > MAX_OUTPUT || text.contains('\0') {
        return Err(UNAVAILABLE.into());
    }
    Ok(text)
}
fn positive(value: &str) -> Result<u64, String> {
    if value.is_empty() || !value.bytes().all(|v| v.is_ascii_digit()) {
        return Err(UNAVAILABLE.into());
    }
    value
        .parse::<u64>()
        .ok()
        .filter(|v| *v > 0)
        .ok_or_else(|| UNAVAILABLE.into())
}
fn single<'a>(values: impl Iterator<Item = &'a str>) -> Result<&'a str, String> {
    let mut values = values;
    let value = values.next().ok_or(UNAVAILABLE)?;
    if values.next().is_some() {
        return Err(UNAVAILABLE.into());
    }
    Ok(value)
}
fn property<'a>(text: &'a str, key: &str) -> Result<&'a str, String> {
    single(text.lines().filter_map(|line| {
        line.split_once('=')
            .filter(|(k, _)| *k == key)
            .map(|(_, v)| v)
    }))
}
fn registration(
    platform: Platform,
    uid: u32,
    runner: &mut impl Runner,
) -> Result<(String, u32, String), String> {
    match platform {
        Platform::Mac => {
            let service = format!("gui/{uid}/app.emulator-content-server");
            let text = output(runner, "/bin/launchctl", &["print", &service])?;
            if text.lines().next() != Some(&format!("{service} = {{"))
                || text.lines().last() != Some("}")
            {
                return Err(UNAVAILABLE.into());
            }
            // Only top-level properties count; nested environment/arguments are never inspected.
            let get = |key: &str| {
                single(
                    text.lines()
                        .filter_map(move |line| line.strip_prefix(&format!("\t{key} = "))),
                )
            };
            if get("state")? != "running" {
                return Err(UNAVAILABLE.into());
            }
            let pid = u32::try_from(positive(get("pid")?)?).map_err(|_| UNAVAILABLE)?;
            let runs = positive(get("runs")?)?;
            Ok((service, pid, runs.to_string()))
        }
        Platform::Linux => {
            let text = output(runner, "/usr/bin/systemctl", LINUX_SHOW)?;
            if property(&text, "Id")? != "ecs.service"
                || property(&text, "LoadState")? != "loaded"
                || property(&text, "ActiveState")? != "active"
                || property(&text, "SubState")? != "running"
            {
                return Err(UNAVAILABLE.into());
            }
            let pid =
                u32::try_from(positive(property(&text, "MainPID")?)?).map_err(|_| UNAVAILABLE)?;
            let invocation = property(&text, "InvocationID")?;
            if invocation.len() != 32 || !invocation.bytes().all(|v| v.is_ascii_hexdigit()) {
                return Err(UNAVAILABLE.into());
            }
            let start = positive(property(&text, "ExecMainStartTimestampMonotonic")?)?;
            Ok((
                format!("user/{uid}/ecs.service"),
                pid,
                format!("{invocation}:{start}"),
            ))
        }
        _ => Err(UNAVAILABLE.into()),
    }
}
fn loopback_listener(value: &str) -> Result<String, String> {
    let (host, port) = value.rsplit_once(':').ok_or(UNAVAILABLE)?;
    if !matches!(host, "127.0.0.1" | "[::1]") || positive(port)? > 65535 {
        return Err(UNAVAILABLE.into());
    }
    // Reject noncanonical ports too, so endpoint identity compares exactly.
    if port.parse::<u16>().map_err(|_| UNAVAILABLE)?.to_string() != port {
        return Err(UNAVAILABLE.into());
    }
    Ok(value.into())
}
fn lsof_listener(text: &str, pid: u32, uid: u32) -> Result<String, String> {
    let mut found_pid = None;
    let mut found_uid = None;
    let mut fd = false;
    let mut name = None;
    let mut listening = false;
    for line in text.lines() {
        if let Some(value) = line.strip_prefix('p') {
            if found_pid.replace(positive(value)?).is_some() {
                return Err(UNAVAILABLE.into());
            }
        } else if let Some(value) = line.strip_prefix('u') {
            if found_uid.replace(positive(value)?).is_some() {
                return Err(UNAVAILABLE.into());
            }
        } else if line.starts_with('f') {
            if fd {
                return Err(UNAVAILABLE.into());
            }
            fd = true;
        } else if let Some(value) = line.strip_prefix('n') {
            if name.replace(loopback_listener(value)?).is_some() {
                return Err(UNAVAILABLE.into());
            }
        } else if line == "TST=LISTEN" {
            if listening {
                return Err(UNAVAILABLE.into());
            }
            listening = true;
        } else if !line.starts_with('T') {
            return Err(UNAVAILABLE.into());
        }
    }
    if found_pid != Some(pid.into()) || found_uid != Some(uid.into()) || !fd || !listening {
        return Err(UNAVAILABLE.into());
    }
    name.ok_or_else(|| UNAVAILABLE.into())
}
fn ss_listener(text: &str, pid: u32, uid: u32) -> Result<String, String> {
    let mut candidate = None;
    let pid_marker = format!("pid={pid},");
    for line in text.lines() {
        if !line.contains(&pid_marker) {
            continue;
        }
        if candidate.is_some() {
            return Err(UNAVAILABLE.into());
        }
        let fields: Vec<_> = line.split_whitespace().collect();
        if fields.len() < 6
            || fields[0] != "LISTEN"
            || line.matches("pid=").count() != 1
            || single(fields.iter().filter_map(|f| f.strip_prefix("uid:")))? != uid.to_string()
        {
            return Err(UNAVAILABLE.into());
        }
        candidate = Some(loopback_listener(fields[3])?);
    }
    let listener = candidate.ok_or(UNAVAILABLE)?;
    // SO_REUSEPORT, shared owners or hidden ownership must not pass correlation.
    if text
        .lines()
        .filter(|l| {
            let Some(address) = l.split_whitespace().nth(3) else {
                return false;
            };
            address == listener
                || address == format!("0.0.0.0:{}", listener.rsplit_once(':').unwrap().1)
                || address == format!("[::]:{}", listener.rsplit_once(':').unwrap().1)
                || address == format!("*:{}", listener.rsplit_once(':').unwrap().1)
        })
        .count()
        != 1
    {
        return Err(UNAVAILABLE.into());
    }
    Ok(listener)
}
pub fn inspect(platform: Platform, uid: u32, runner: &mut impl Runner) -> Result<Snapshot, String> {
    if uid == 0 || !matches!(platform, Platform::Mac | Platform::Linux) {
        return Err(UNAVAILABLE.into());
    }
    let (service, pid, generation) = registration(platform, uid, runner)?;
    let process = runner.process(pid).map_err(|_| UNAVAILABLE)?;
    if process.uid != uid || process.start.is_empty() {
        return Err(UNAVAILABLE.into());
    }
    let listener = match platform {
        Platform::Mac => {
            let pid_text = pid.to_string();
            let text = output(
                runner,
                "/usr/sbin/lsof",
                &[
                    "-nP",
                    "-a",
                    "-p",
                    &pid_text,
                    "-iTCP",
                    "-sTCP:LISTEN",
                    "-FpufnT",
                ],
            )?;
            let listener = lsof_listener(&text, pid, uid)?;
            let filter = format!("-iTCP@{}", listener);
            let text = output(
                runner,
                "/usr/sbin/lsof",
                &["-nP", &filter, "-sTCP:LISTEN", "-FpufnT"],
            )?;
            if lsof_listener(&text, pid, uid)? != listener {
                return Err(UNAVAILABLE.into());
            }
            listener
        }
        Platform::Linux => {
            ss_listener(&output(runner, "/usr/bin/ss", &["-H", "-ltnpe"])?, pid, uid)?
        }
        _ => return Err(UNAVAILABLE.into()),
    };
    if registration(platform, uid, runner)? != (service.clone(), pid, generation.clone())
        || runner.process(pid).map_err(|_| UNAVAILABLE)? != process
    {
        return Err(UNAVAILABLE.into());
    }
    Ok(Snapshot {
        service,
        uid,
        pid,
        start: process.start,
        generation,
        listener,
    })
}

#[derive(Default)]
pub struct Verifications {
    entries: VecDeque<(String, Snapshot, Instant)>,
}
impl Verifications {
    pub fn bind(&mut self, snapshot: Snapshot) -> String {
        self.entries
            .retain(|(_, _, time)| time.elapsed() < Duration::from_secs(1800));
        while self.entries.len() >= 16 {
            self.entries.pop_front();
        }
        let id = uuid::Uuid::new_v4().to_string();
        self.entries
            .push_back((id.clone(), snapshot, Instant::now()));
        id
    }
    pub fn validate(&mut self, id: &str, current: Option<&Snapshot>) -> bool {
        if id.len() > 64 {
            return false;
        }
        let Some(index) = self.entries.iter().position(|(key, _, _)| key == id) else {
            return false;
        };
        let (_, snapshot, time) = &self.entries[index];
        if time.elapsed() >= Duration::from_secs(1800) || current != Some(snapshot) {
            self.entries.remove(index);
            return false;
        }
        true
    }
    pub fn endpoint(&mut self) -> serde_json::Value {
        match current() {
            Ok(snapshot) => {
                let origin = snapshot.origin();
                let id = self.bind(snapshot);
                serde_json::json!({ "available": true, "origin": origin, "verificationId": id })
            }
            Err(_) => serde_json::json!({"available": false, "reason": UNAVAILABLE}),
        }
    }
}
pub fn choose_verified(
    state: &mut Verifications,
    id: &str,
    purpose: &str,
    mut inspect: impl FnMut() -> Option<Snapshot>,
    dialog: impl FnOnce() -> Result<Option<String>, String>,
) -> Result<Option<String>, String> {
    if !matches!(purpose, "library-folder" | "upload-storage") || id.len() > 64 {
        return Err(UNAVAILABLE.into());
    }
    if !state.validate(id, inspect().as_ref()) {
        return Err(UNAVAILABLE.into());
    }
    let path = dialog().map_err(|_| UNAVAILABLE)?;
    if !state.validate(id, inspect().as_ref()) {
        return Err(UNAVAILABLE.into());
    }
    if path.as_ref().is_some_and(|p| {
        p.len() > 32768 || p.contains('\0') || !std::path::Path::new(p).is_absolute()
    }) {
        return Err(UNAVAILABLE.into());
    }
    Ok(path)
}
#[cfg(test)]
#[path = "local_endpoint_tests.rs"]
mod tests;
