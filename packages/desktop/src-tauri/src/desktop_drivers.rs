#[path = "desktop_daemon_peer.rs"]
mod peer;
pub(crate) use peer::wait_unreaped;
#[path = "desktop_driver_channel.rs"]
mod channel;
#[path = "desktop_grants.rs"]
mod grants;
#[path = "desktop_leases.rs"]
mod leases;
#[path = "desktop_driver_record.rs"]
mod record;
#[path = "desktop_target.rs"]
mod target;
use serde_json::{json, Value};
#[cfg(test)]
use std::sync::atomic::{AtomicBool, Ordering};
use std::{
    collections::BTreeMap,
    fs::{File, OpenOptions},
    os::fd::AsRawFd,
    os::unix::fs::{DirBuilderExt, FileTypeExt, MetadataExt, OpenOptionsExt, PermissionsExt},
    path::PathBuf,
    sync::{Arc, Mutex as StdMutex},
    time::Duration,
};
use tempfile::TempDir;
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    net::UnixListener,
    process::Command,
    sync::{Mutex, OwnedMutexGuard},
    task::{JoinHandle, JoinSet},
    time::{timeout, timeout_at, Instant},
};

pub(crate) async fn owner_answer<F: std::future::Future<Output = &'static str>>(
    deadline: Instant,
    answer: F,
) -> &'static str {
    timeout_at(deadline, answer)
        .await
        .unwrap_or("waiting_for_owner")
}

#[cfg(test)]
static FAIL_NEXT_ACCEPT: AtomicBool = AtomicBool::new(false);
#[cfg(test)]
static LATCH_ON_RESPONSE: AtomicBool = AtomicBool::new(false);
#[cfg(test)]
static FAIL_START_CLEANUP: AtomicBool = AtomicBool::new(false);
#[cfg(test)]
static FAIL_RETIRE: AtomicBool = AtomicBool::new(false);
#[cfg(test)]
pub(crate) fn inject_accept_failure() {
    FAIL_NEXT_ACCEPT.store(true, Ordering::Relaxed);
}

type Result<T> = std::result::Result<T, Box<dyn std::error::Error + Send + Sync>>;

// An unfiltered listing names every app's windows; keep only the todo's approved apps.
fn scoped_windows(mut body: Value, apps: &[String]) -> Value {
    let mut owners = BTreeMap::new();
    let mut allowed = |pid: i64| {
        *owners.entry(pid).or_insert_with(|| {
            target::resolve("list_windows", &json!({ "pid": pid }), None)["value"]["bundle_id"]
                .as_str()
                .is_some_and(|bundle| apps.iter().any(|app| app == bundle))
        })
    };
    let windows: Vec<Value> = body["structuredContent"]["windows"]
        .as_array()
        .map(|all| {
            all.iter()
                .filter(|window| window["pid"].as_i64().is_some_and(&mut allowed))
                .cloned()
                .collect()
        })
        .unwrap_or_default();
    let text = windows
        .iter()
        .map(|window| {
            format!(
                "- {} (pid {}) \"{}\" [window_id: {}]",
                window["app_name"].as_str().unwrap_or_default(),
                window["pid"],
                window["title"].as_str().unwrap_or_default(),
                window["window_id"]
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    body["structuredContent"] = json!({ "windows": windows });
    body["content"] = json!([{ "type": "text", "text": text }]);
    body
}
const LEASE_POLL: Duration = Duration::from_millis(200);
struct Worker {
    channel: channel::Channel,
    _directory: TempDir,
}
struct Drivers {
    workers: Mutex<BTreeMap<String, Arc<Mutex<Option<Worker>>>>>,
    binary: PathBuf,
    verification_path: String,
    records: PathBuf,
    descriptor: PathBuf,
    sidecar: peer::ChildSlot,
    desktop_ready: Arc<dyn Fn() -> bool + Send + Sync>,
    leases: StdMutex<leases::Leases>,
    foreground: Arc<Mutex<()>>,
    /// Foreground locks held by workers whose input could not be confirmed stopped.
    stuck: StdMutex<BTreeMap<String, OwnedMutexGuard<()>>>,
    /// Workers whose driver shutdown failed; they get no input until Stop confirms it.
    unconfirmed: StdMutex<std::collections::BTreeSet<String>>,
}
/// Settles a dispatch's leases when it ends, unless its worker's exit is unconfirmed.
struct Settle<'a> {
    drivers: &'a Drivers,
    worker: &'a str,
}
impl Drop for Settle<'_> {
    fn drop(&mut self) {
        if !self.drivers.unconfirmed.lock().unwrap().contains(self.worker) {
            self.drivers
                .leases
                .lock()
                .unwrap()
                .settle(self.worker, Instant::now());
        }
    }
}
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Request {
    action: String,
    worker: String,
    work_dir: Option<PathBuf>,
    tool: Option<String>,
    arguments: Option<Value>,
    instance: Option<Value>,
    call_id: Option<String>,
    /// Bundle ids the daemon's human approved for this worker's todo. A dispatch may act only on these.
    apps: Option<Vec<String>>,
    /// The todo this call works for, and every todo that may still use the desktop.
    todo: Option<String>,
    todos: Option<Vec<String>>,
}
pub(crate) struct Control {
    drivers: Arc<Drivers>,
    task: StdMutex<Option<JoinHandle<()>>>,
    socket: PathBuf,
    _lock: File,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct Advert {
    pid: u64,
    started_at: u64,
}

impl Control {
    pub(crate) async fn setup(
        base: Option<PathBuf>,
        binary: std::io::Result<PathBuf>,
        verification_path: String,
        sidecar: peer::ChildSlot,
        desktop_ready: Arc<dyn Fn() -> bool + Send + Sync>,
    ) -> Option<Self> {
        let (Some(base), Ok(binary)) = (base, binary) else {
            log::warn!("Desktop control unavailable: startup paths unavailable");
            return None;
        };
        match Self::bind(base, binary, verification_path, sidecar, desktop_ready).await {
            Ok(control) => control,
            Err(error) => {
                log::warn!("Desktop control unavailable: {error}");
                None
            }
        }
    }
    async fn bind(
        base: PathBuf,
        binary: PathBuf,
        verification_path: String,
        sidecar: peer::ChildSlot,
        desktop_ready: Arc<dyn Fn() -> bool + Send + Sync>,
    ) -> Result<Option<Self>> {
        let directory = base.join("desktop");
        std::fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(&directory)?;
        let metadata = directory.symlink_metadata()?;
        if !metadata.is_dir()
            || metadata.mode() & 0o777 != 0o700
            || metadata.uid() != unsafe { libc::geteuid() }
        {
            return Err(
                "Desktop control directory must be owned by this user and mode 0700".into(),
            );
        }
        let lock = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .mode(0o600)
            .open(directory.join("control.lock"))?;
        if unsafe {
            libc::flock(
                std::os::fd::AsRawFd::as_raw_fd(&lock),
                libc::LOCK_EX | libc::LOCK_NB,
            )
        } != 0
        {
            let error = std::io::Error::last_os_error();
            if error.kind() == std::io::ErrorKind::WouldBlock {
                return Ok(None);
            }
            return Err(error.into());
        }
        let socket = directory.join("control.sock");
        if let Ok(metadata) = socket.symlink_metadata() {
            if !metadata.file_type().is_socket() {
                return Err("Invalid Desktop control endpoint".into());
            }
            std::fs::remove_file(&socket)?;
        }
        let listener = UnixListener::bind(&socket)?;
        let drivers = Arc::new(Drivers {
            workers: Mutex::new(BTreeMap::new()),
            binary,
            verification_path,
            descriptor: base.join("runtime.json"),
            records: directory,
            sidecar,
            desktop_ready,
            leases: StdMutex::default(),
            foreground: Arc::default(),
            stuck: StdMutex::default(),
            unconfirmed: StdMutex::default(),
        });
        let state = drivers.clone();
        let task = tokio::spawn(async move {
            let mut requests = JoinSet::new();
            loop {
                #[cfg(not(test))]
                let accepted = listener.accept().await;
                #[cfg(test)]
                let accepted = if FAIL_NEXT_ACCEPT.swap(false, Ordering::Relaxed) {
                    Err(std::io::Error::from(std::io::ErrorKind::ConnectionAborted))
                } else {
                    listener.accept().await
                };
                let (mut stream, _) = match accepted {
                    Ok(connection) => connection,
                    Err(error) => {
                        log::warn!("Desktop control accept failed: {error}");
                        tokio::time::sleep(Duration::from_millis(100)).await;
                        continue;
                    }
                };
                while requests.try_join_next().is_some() {}
                if requests.len() >= 16 {
                    let _ = timeout(
                        Duration::from_secs(2),
                        stream.write_all(b"{\"ok\": false, \"error\": \"desktop_busy\"}\n"),
                    )
                    .await;
                    continue;
                }
                let state = state.clone();
                requests.spawn(async move {
                    let authorized = peer_pid(&stream).is_some_and(|pid| state.authorized(pid));
                    let (input, mut output) = stream.into_split();
                    if !authorized {
                        let _ = timeout(
                            Duration::from_secs(2),
                            output.write_all(b"{\"ok\": false, \"error\": \"not_daemon\"}\n"),
                        )
                        .await;
                        return;
                    }
                    let mut line = String::new();
                    let read = timeout(
                        Duration::from_secs(3),
                        BufReader::new(input.take(1 << 20)).read_line(&mut line),
                    )
                    .await;
                    if !matches!(read, Ok(Ok(_))) {
                        return;
                    }
                    let result = if !line.ends_with('\n') && line.len() == 1 << 20 {
                        Err("request_too_large".into())
                    } else if !line.ends_with('\n') {
                        return;
                    } else {
                        match serde_json::from_str(&line) {
                            Ok(request) => state.request(request).await,
                            Err(error) => Err(error.into()),
                        }
                    };
                    let response = match result {
                        Ok(result) => json!({"ok": true, "result": result}),
                        Err(error) => json!({"ok": false, "error": error.to_string()}),
                    };
                    let _ = timeout(
                        Duration::from_secs(2),
                        output.write_all(format!("{response}\n").as_bytes()),
                    )
                    .await;
                });
            }
        });
        Ok(Some(Self {
            drivers,
            task: StdMutex::new(Some(task)),
            socket,
            _lock: lock,
        }))
    }
    pub(crate) async fn shutdown(&self) {
        // Hold every worker first, so requests cancelled below neither settle leases nor admit
        // input; only a confirmed retirement releases a worker.
        for id in self.drivers.workers.lock().await.keys() {
            self.drivers.hold(id);
        }
        let task = self.task.lock().unwrap().take();
        if let Some(task) = task {
            task.abort();
            let _ = task.await;
        }
        let slots: Vec<_> = self
            .drivers
            .workers
            .lock()
            .await
            .iter()
            .map(|(id, slot)| (id.clone(), slot.clone()))
            .collect();
        for (id, slot) in slots {
            if let Err(error) = self.drivers.retire(&id, &mut *slot.lock().await).await {
                log::error!("Driver shutdown failed: {error}");
            }
        }
        let _ = std::fs::remove_file(&self.socket);
    }
}
impl Drop for Control {
    fn drop(&mut self) {
        if let Some(task) = self.task.get_mut().unwrap().take() {
            task.abort();
        }
        let _ = std::fs::remove_file(&self.socket);
    }
}

fn peer_pid(stream: &tokio::net::UnixStream) -> Option<u32> {
    let mut pid: libc::pid_t = 0;
    let mut length = std::mem::size_of::<libc::pid_t>() as libc::socklen_t;
    let read = unsafe {
        libc::getsockopt(
            stream.as_raw_fd(),
            libc::SOL_LOCAL,
            libc::LOCAL_PEEREPID,
            (&mut pid as *mut libc::pid_t).cast(),
            &mut length,
        )
    };
    (read == 0 && pid > 1).then_some(pid as u32)
}

impl Drivers {
    fn authorized(&self, peer: u32) -> bool {
        if self
            .sidecar
            .lock()
            .unwrap()
            .as_ref()
            .is_some_and(|child| child.id() == peer)
        {
            return true;
        }
        self.daemon(peer)
    }

    fn daemon(&self, peer: u32) -> bool {
        let Ok(raw) = std::fs::read(&self.descriptor) else {
            return false;
        };
        let Ok(advert) = serde_json::from_slice::<Advert>(&raw) else {
            return false;
        };
        if advert.pid != u64::from(peer) {
            return false;
        }
        let advertised = advert.started_at / 1000;
        let Ok(process) = record::identity(peer) else {
            return false;
        };
        process.seconds <= advertised && process.seconds + 60 >= advertised
    }
    async fn request(&self, request: Request) -> Result<Value> {
        #[cfg(test)]
        let deadline = if request
            .arguments
            .as_ref()
            .is_some_and(|args| args["fixture_deadline"] == true)
        {
            Instant::now() + Duration::from_millis(300)
        } else {
            Instant::now() + Duration::from_secs(20)
        };
        #[cfg(not(test))]
        let deadline = Instant::now() + Duration::from_secs(20);
        if request.worker.is_empty()
            || request.worker.len() > 64
            || !request
                .worker
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        {
            return Err("Invalid worker identifier".into());
        }
        #[cfg(test)]
        if request.action == "fixture-fail-start-cleanup" {
            FAIL_START_CLEANUP.store(true, Ordering::Relaxed);
            return Ok(json!({"armed": true}));
        }
        #[cfg(test)]
        if request.action == "fixture-fail-retire" {
            FAIL_RETIRE.store(true, Ordering::Relaxed);
            return Ok(json!({"armed": true}));
        }
        #[cfg(test)]
        if request.action == "fixture-latch-on-response" {
            LATCH_ON_RESPONSE.store(true, Ordering::Relaxed);
            return Ok(json!({"armed": true}));
        }
        #[cfg(test)]
        if request.action == "fixture-dialog" {
            if let Some(mode) = request.tool.as_deref() {
                grants::FIXTURE_DIALOG.lock().unwrap().0 = match mode {
                    "allow" => "allow",
                    "hold" => "hold",
                    "panic" => "panic",
                    "real" => "real",
                    "mock-allow" => "mock-allow",
                    "mock-allow-all" => "mock-allow-all",
                    "mock-deny" => "mock-deny",
                    "mock-hold" => "mock-hold",
                    _ => "deny",
                };
                grants::ASKS.lock().unwrap().1.clear();
            }
            return Ok(json!({"dialogs": grants::FIXTURE_DIALOG.lock().unwrap().1}));
        }
        #[cfg(test)]
        if request.action == "fixture-dialog-texts" {
            return Ok(json!({"texts": grants::dialog_texts()}));
        }
        #[cfg(test)]
        if request.action == "fixture-dialog-buttons" {
            let bundle = request
                .tool
                .unwrap_or_else(|| "com.apple.calculator".to_owned());
            return Ok(json!({"buttons": grants::dialog_buttons(bundle)}));
        }
        #[cfg(test)]
        if request.action == "fixture-slots" {
            let slots = self.workers.lock().await;
            return Ok(
                json!({"count": slots.len(), "references": slots.get(&request.worker).map(Arc::strong_count).unwrap_or(0)}),
            );
        }
        if matches!(
            request.action.as_str(),
            "resolve" | "fixture-target" | "fixture-grant" | "fixture-revoke" | "fixture-admit"
        ) {
            let tool = request.tool.as_deref().unwrap_or_default();
            let arguments = request.arguments.unwrap_or(Value::Null);
            let mut result = target::resolve(tool, &arguments, request.instance.as_ref());
            let value = &result["value"];
            let tuple =
                [&value["bundle_id"], &value["requirement"], &value["class"]].map(Value::as_str);
            if let [Some(bundle), Some(requirement), Some(class)] = tuple {
                match request.action.as_str() {
                    "resolve" if bundle == "io.hyperneo.app" => {
                        result = json!({"reason": "app_not_grantable", "class": class, "bundle_id": bundle});
                    }
                    "resolve" => {
                        if let Err(reason) = grants::check(bundle, requirement, class) {
                            let reason = if reason == "app_action_not_authorized" {
                                let (bundle, requirement, class) =
                                    (bundle.to_owned(), requirement.to_owned(), class.to_owned());
                                owner_answer(deadline, async move {
                                    tokio::task::spawn_blocking(move || {
                                        grants::ask_owner(&bundle, &requirement, &class)
                                    })
                                    .await
                                    .unwrap_or("guards_unavailable")
                                })
                                .await
                            } else {
                                reason
                            };
                            if reason != "allowed" {
                                result =
                                    json!({"reason": reason, "class": class, "bundle_id": bundle});
                            }
                        }
                    }
                    #[cfg(test)]
                    "fixture-grant" | "fixture-revoke" => grants::record(
                        bundle,
                        requirement,
                        class,
                        request.action == "fixture-grant",
                    )?,
                    #[cfg(test)]
                    "fixture-admit" => grants::admit(bundle, requirement, class),
                    #[cfg(test)]
                    "fixture-target" => {}
                    _ => return Err("Unknown Desktop control action".into()),
                }
            } else if request.action != "resolve" && !cfg!(test) {
                return Err("Unknown Desktop control action".into());
            }
            result["call_id"] = json!(request.call_id);
            return Ok(result);
        }
        let call_id = json!(request.call_id);
        let finish =
            move |app: Value, class: Value, decision: &str, reason: Value, dispatched: bool| {
                json!({"call_id": call_id, "bundle_id": app, "class": class,
                    "decision": decision, "reason": reason, "dispatched": dispatched})
            };
        let mut bundle = Value::Null;
        let mut class = Value::Null;
        let mut observed = Value::Null;
        let unscoped_windows = request.action == "dispatch"
            && request.tool.as_deref() == Some("list_windows")
            && request
                .arguments
                .as_ref()
                .is_none_or(|args| args["pid"].is_null() && args["app"].is_null());
        if request.action == "dispatch"
            && record::ensure_enabled(&self.records.join("workers").join(&request.worker)).is_err()
        {
            return Err("Desktop worker is stopped".into());
        }
        #[cfg(not(test))]
        let screen_locked = target::screen_locked;
        #[cfg(test)]
        let screen_locked = || {
            request
                .arguments
                .as_ref()
                .is_some_and(|args| args["fixture_screen_locked"] == true)
        };
        if request.action == "dispatch" && screen_locked() {
            return Ok(finish(
                bundle,
                class,
                "refused",
                json!("screen_locked"),
                false,
            ));
        }
        if request.action == "dispatch" && !(self.desktop_ready)() {
            return Ok(finish(
                Value::Null,
                Value::Null,
                "refused",
                json!("desktop_permissions_required"),
                false,
            ));
        }
        if request.action == "dispatch" && !unscoped_windows {
            let tool = request.tool.as_deref().unwrap_or_default();
            let arguments = request.arguments.clone().unwrap_or(Value::Null);
            let resolved = target::resolve(tool, &arguments, request.instance.as_ref());
            observed = resolved["value"].clone();
            bundle = observed["bundle_id"].clone();
            class = resolved["value"]["class"].clone();
            let in_scope = bundle.as_str().is_some_and(|id| {
                request
                    .apps
                    .as_ref()
                    .is_some_and(|apps| apps.iter().any(|app| app == id))
            });
            let reason = if let Some(reason) = resolved["reason"].as_str() {
                json!(reason)
            } else if bundle == "io.hyperneo.app" {
                json!("app_not_grantable")
            } else if !in_scope {
                json!("app_not_in_todo_scope")
            } else {
                let requirement = resolved["value"]["requirement"]
                    .as_str()
                    .unwrap_or_default();
                let class_name = class.as_str().unwrap_or_default();
                match grants::check(bundle.as_str().unwrap_or_default(), requirement, class_name) {
                    Ok(()) => Value::Null,
                    Err(reason) if reason == "app_action_not_authorized" => {
                        let (app, requirement, class_name) = (
                            bundle.as_str().unwrap_or_default().to_owned(),
                            requirement.to_owned(),
                            class_name.to_owned(),
                        );
                        let answer = owner_answer(deadline, async move {
                            tokio::task::spawn_blocking(move || {
                                grants::ask_owner(&app, &requirement, &class_name)
                            })
                            .await
                            .unwrap_or("guards_unavailable")
                        })
                        .await;
                        if answer == "allowed" {
                            Value::Null
                        } else {
                            json!(answer)
                        }
                    }
                    Err(reason) => json!(reason),
                }
            };
            if !reason.is_null() || !bundle.is_string() || !class.is_string() {
                let reply = finish(
                    bundle,
                    class,
                    "refused",
                    if reason.is_null() {
                        json!("target_unverified")
                    } else {
                        reason
                    },
                    false,
                );
                log::info!(
                    "Desktop dispatch {worker} refused: {reply}",
                    worker = request.worker
                );
                return Ok(reply);
            }
        }
        let directory = self.records.join("workers").join(&request.worker);
        if matches!(request.action.as_str(), "start" | "stop" | "dispatch") {
            record::directory(&self.records, &request.worker, true)?;
        }
        if request.action == "stop" {
            record::latch(&directory)?;
        }
        if matches!(request.action.as_str(), "start" | "dispatch") {
            record::ensure_enabled(&directory)?;
        }
        let worker_id = request.worker.clone();
        let slot = {
            let mut slots = self.workers.lock().await;
            if !matches!(request.action.as_str(), "start" | "dispatch")
                && !slots.contains_key(&worker_id)
            {
                if request.action == "stop" {
                    self.retire(&worker_id, &mut None).await?;
                }
                return match request.action.as_str() {
                    "status" | "stop" => Ok(json!({"state": "stopped", "pid": null})),
                    _ => Err("Unknown Desktop control action".into()),
                };
            }
            slots.entry(worker_id.clone()).or_default().clone()
        };
        let mut worker = if request.action == "dispatch" {
            match timeout_at(deadline, slot.lock()).await {
                Ok(worker) => worker,
                Err(_) => {
                    return Ok(finish(
                        bundle,
                        class,
                        "refused",
                        json!("desktop_busy"),
                        false,
                    ))
                }
            }
        } else {
            slot.lock().await
        };
        let result: Result<Option<Value>> = async {
            match request.action.as_str() {
                "start" => {
                    if self.unconfirmed.lock().unwrap().contains(&worker_id) {
                        return Err("stop_unconfirmed: Stop must confirm the old driver exited".into());
                    }
                    self.start_driver(&worker_id, &directory, &mut worker, request.work_dir.as_deref())
                        .await?
                }
                "dispatch" => {
                    if self.unconfirmed.lock().unwrap().contains(&worker_id) {
                        return Ok(Some(finish(
                            bundle,
                            class,
                            "refused",
                            json!("stop_unconfirmed"),
                            false,
                        )));
                    }
                    let _settle = Settle {
                        drivers: self,
                        worker: &worker_id,
                    };
                    if let Some(wanted) = leases::Target::of(&observed) {
                        let todo = request.todo.as_deref().unwrap_or_default();
                        let todos = request.todos.as_deref().unwrap_or_default();
                        let live =
                            |held: &leases::Target| target::alive(&held.instance, held.window);
                        loop {
                            let taken = self.leases.lock().unwrap().acquire(
                                &worker_id,
                                todo,
                                todos,
                                &wanted,
                                Instant::now(),
                                live,
                            );
                            match taken {
                                Ok(()) => break,
                                Err(_) if Instant::now() + LEASE_POLL < deadline => {
                                    tokio::time::sleep(LEASE_POLL).await
                                }
                                Err(holder) => {
                                    log::info!(
                                        "Desktop dispatch {worker_id}: window held by {holder}"
                                    );
                                    return Ok(Some(finish(
                                        bundle,
                                        class,
                                        "refused",
                                        json!("window_busy"),
                                        false,
                                    )));
                                }
                            }
                        }
                    }
                    if worker.is_none() {
                        self.start_driver(&worker_id, &directory, &mut worker, request.work_dir.as_deref())
                            .await?;
                    }
                    if screen_locked() {
                        return Ok(Some(finish(
                            bundle,
                            class,
                            "refused",
                            json!("screen_locked"),
                            false,
                        )));
                    }
                    let foreground = request
                        .arguments
                        .as_ref()
                        .is_some_and(|args| args["delivery_mode"] == "foreground");
                    let mut screen = if foreground {
                        match timeout_at(deadline, self.foreground.clone().lock_owned()).await {
                            Ok(guard) => Some(guard),
                            Err(_) => {
                                return Ok(Some(finish(
                                    bundle,
                                    class,
                                    "refused",
                                    json!("foreground_busy"),
                                    false,
                                )))
                            }
                        }
                    } else {
                        None
                    };
                    let current = target::resolve(
                        request.tool.as_deref().unwrap_or_default(),
                        request.arguments.as_ref().unwrap_or(&Value::Null),
                        observed.get("instance"),
                    );
                    if !unscoped_windows && current["value"] != observed {
                        let reply =
                            finish(bundle, class, "refused", json!("target_mismatch"), false);
                        log::info!(
                            "Desktop dispatch {worker}: {reply}",
                            worker = request.worker
                        );
                        return Ok(Some(reply));
                    }
                    if Instant::now() >= deadline {
                        return Ok(Some(finish(
                            bundle,
                            class,
                            "refused",
                            json!("desktop_timeout"),
                            false,
                        )));
                    }
                    #[cfg(not(test))]
                    let limit = Duration::from_secs(30);
                    #[cfg(test)]
                    let limit = if request
                        .arguments
                        .as_ref()
                        .is_some_and(|args| args["fixture_timeline"].is_string())
                    {
                        Duration::from_secs(2)
                    } else {
                        Duration::from_millis(100)
                    };
                    let active = worker.as_mut().unwrap();
                    let call = timeout_at(
                        deadline.min(Instant::now() + limit),
                        active.channel.call(
                            request.tool.as_deref().unwrap_or_default(),
                            request.arguments.clone(),
                        ),
                    )
                    .await;
                    let sent = active.channel.sent;
                    let mut body = Value::Null;
                    let mut reason = match call {
                        Ok(Ok(result)) => {
                            body = result;
                            Value::Null
                        }
                        Ok(Err(error)) => json!(error.to_string()),
                        Err(_) => json!("driver call timed out"),
                    };
                    if !reason.is_null() {
                        #[cfg(test)]
                        if request
                            .arguments
                            .as_ref()
                            .is_some_and(|args| args["fixture_close_fails"] == true)
                        {
                            FAIL_RETIRE.store(true, Ordering::Relaxed);
                        }
                        if let Err(error) = self.retire(&worker_id, &mut worker).await {
                            reason = json!(error.to_string());
                            if let Some(guard) = screen.take() {
                                self.stuck.lock().unwrap().insert(worker_id.clone(), guard);
                            }
                        }
                    }
                    // The driver reports tool failures in its result, not on the channel.
                    let structured = &body["structuredContent"];
                    if (body["isError"] == true && structured["code"] == "screen_locked")
                        || (request.tool.as_deref() == Some("get_window_state")
                            && structured["degraded_reason"]
                                .as_str()
                                .is_some_and(|reason| reason.starts_with("screen_locked:")))
                    {
                        reason = json!("screen_locked");
                    } else if body["isError"] == true {
                        reason = json!("driver_error");
                    }
                    if unscoped_windows {
                        body = scoped_windows(body, request.apps.as_deref().unwrap_or_default());
                    }
                    let mut reply = finish(bundle, class, "allowed", reason, sent);
                    log::info!(
                        "Desktop dispatch {worker}: {reply}",
                        worker = request.worker
                    );
                    for key in ["content", "structuredContent"] {
                        if !body[key].is_null() {
                            reply[key] = body[key].take();
                        }
                    }
                    return Ok(Some(reply));
                }
                "stop" => {
                    self.leases.lock().unwrap().pin(&worker_id);
                    let running = worker.as_mut().and_then(|active| {
                        active.channel.running().then_some(active.channel.pid)
                    });
                    if let Some(pid) = running {
                        if let Err(error) = record::verify(&directory, pid) {
                            self.unconfirmed.lock().unwrap().insert(worker_id.clone());
                            return Err(format!("stop_unconfirmed: {error}").into());
                        }
                    }
                    self.retire(&worker_id, &mut worker).await?;
                }
                "status" => {}
                _ => return Err("Unknown Desktop control action".into()),
            }
            if let Some(pid) = worker.as_ref().map(|worker| worker.channel.pid) {
                #[cfg(test)]
                if request.action == "start" && LATCH_ON_RESPONSE.swap(false, Ordering::Relaxed) {
                    record::latch(&directory)?;
                }
                let valid = record::directory(&self.records, &request.worker, false)
                    .and_then(|_| record::ensure_enabled(&directory))
                    .and_then(|_| record::verify(&directory, pid));
                if let Err(error) = valid {
                    if request.action == "start" {
                        self.retire(&worker_id, &mut worker).await?;
                    }
                    return Err(error);
                }
            }
            Ok(None)
        }
        .await;
        // A driver whose exit is unconfirmed stays in its slot so Stop can confirm it.
        if !self.unconfirmed.lock().unwrap().contains(&worker_id)
            && worker
                .as_mut()
                .is_some_and(|worker| !worker.channel.running())
        {
            let _ = self.retire(&worker_id, &mut worker).await;
        }
        if worker.is_none() {
            let mut slots = self.workers.lock().await;
            // The map and this request must be the only owners before removal.
            if Arc::strong_count(&slot) == 2 {
                slots.remove(&worker_id);
            }
        }
        Ok(result?.unwrap_or_else(|| match worker.as_ref() {
            Some(worker) => json!({"state": "running", "pid": worker.channel.pid}),
            None => json!({"state": "stopped", "pid": null}),
        }))
    }

    /// The only way a driver leaves its slot: its exit is confirmed, or the worker is marked
    /// unconfirmed and keeps the slot, its leases and any parked foreground lock until a Stop
    /// confirms it.
    /// Marks a worker unconfirmed: no start or input, and its leases stay pinned.
    fn hold(&self, worker_id: &str) {
        self.unconfirmed.lock().unwrap().insert(worker_id.to_owned());
        self.leases.lock().unwrap().pin(worker_id);
    }

    async fn retire(&self, worker_id: &str, worker: &mut Option<Worker>) -> Result<()> {
        let confirmed: Result<()> = async {
            if let Some(active) = worker.as_mut() {
                let pid = active.channel.pid;
                #[cfg(test)]
                if FAIL_RETIRE.swap(false, Ordering::Relaxed) {
                    active.channel.drop_stream();
                    return Err("fixture close failure".into());
                }
                active.channel.close().await?;
                record::verify_gone(pid)?;
            }
            Ok(())
        }
        .await;
        match confirmed {
            Ok(()) => {
                *worker = None;
                self.leases.lock().unwrap().release(worker_id);
                self.stuck.lock().unwrap().remove(worker_id);
                self.unconfirmed.lock().unwrap().remove(worker_id);
                Ok(())
            }
            Err(error) => {
                self.hold(worker_id);
                Err(format!("stop_unconfirmed: {error}").into())
            }
        }
    }

    async fn start_driver(
        &self,
        worker_id: &str,
        directory: &std::path::Path,
        worker: &mut Option<Worker>,
        work_dir: Option<&std::path::Path>,
    ) -> Result<()> {
        let mut starting = record::Starting::begin(directory)?;
        let app = self
            .binary
            .parent()
            .and_then(|p| p.parent())
            .and_then(|p| p.parent())
            .ok_or("Invalid bundled driver path")?;
        let mut signature = Command::new("/bin/bash");
        signature
            .args(["-c", include_str!("../../verify-macos-bundle.sh"), "--"])
            .arg(app)
            .arg("--driver-only")
            .env_clear()
            .env("PATH", &self.verification_path)
            .kill_on_drop(true);
        if !timeout(Duration::from_secs(5), signature.output())
            .await
            .map_err(|_| "Driver signature validation timed out")??
            .status
            .success()
        {
            return Err("Driver signature validation failed".into());
        }
        if worker.is_none() {
            let directory = tempfile::Builder::new()
                .prefix("d-")
                .permissions(std::fs::Permissions::from_mode(0o700))
                .tempdir_in(work_dir.ok_or("workDir is required")?.canonicalize()?)?;
            let home = directory
                .path()
                .to_str()
                .ok_or("Invalid worker directory")?;
            let channel = channel::Channel::open(
                &self.binary,
                &[
                    ("HOME", home),
                    ("TMPDIR", home),
                    ("CUA_DRIVER_RS_HOME", home),
                    ("CUA_DRIVER_RS_TELEMETRY_ENABLED", "0"),
                    ("CUA_DRIVER_RS_UPDATE_CHECK", "0"),
                    ("CUA_DRIVER_ALLOW_CAPTURE_CONSENT_ALERT", "1"),
                ],
            )
            .await?;
            *worker = Some(Worker {
                channel,
                _directory: directory,
            });
        }
        let pid = worker.as_ref().unwrap().channel.pid;
        if let Err(error) =
            record::publish(directory, pid).and_then(|_| record::ensure_enabled(directory))
        {
            starting.preserve();
            #[cfg(test)]
            if FAIL_START_CLEANUP.swap(false, Ordering::Relaxed) {
                FAIL_RETIRE.store(true, Ordering::Relaxed);
            }
            self.retire(worker_id, worker).await?;
            starting.cleanup_verified();
            return Err(error);
        }
        Ok(())
    }
}

#[cfg(test)]
mod peer_tests {
    use super::*;
    #[test]
    fn reaped_sidecar_is_not_authorized() {
        let child = std::process::Command::new("/usr/bin/true").spawn().unwrap();
        let pid = child.id();
        let directory = tempfile::tempdir().unwrap();
        let drivers = Drivers {
            workers: Mutex::new(BTreeMap::new()),
            binary: PathBuf::new(),
            verification_path: String::new(),
            records: directory.path().into(),
            descriptor: directory.path().join("missing-runtime.json"),
            sidecar: Arc::new(StdMutex::new(Some(child))),
            desktop_ready: Arc::new(|| true),
            leases: StdMutex::default(),
            foreground: Arc::default(),
            stuck: StdMutex::default(),
            unconfirmed: StdMutex::default(),
        };
        assert_eq!(wait_unreaped(pid).unwrap(), (Some(0), None));
        assert!(drivers.authorized(pid));
        let mut child = drivers.sidecar.lock().unwrap().take().unwrap();
        child.wait().unwrap();
        assert!(!drivers.authorized(pid));
    }
}
