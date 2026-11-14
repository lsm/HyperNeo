#[path = "desktop_driver_channel.rs"]
mod channel;
#[path = "desktop_grants.rs"]
mod grants;
#[path = "desktop_driver_record.rs"]
mod record;
#[path = "desktop_target.rs"]
mod target;
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    fs::{File, OpenOptions},
    os::unix::fs::{DirBuilderExt, FileTypeExt, MetadataExt, OpenOptionsExt, PermissionsExt},
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex as StdMutex,
    },
    time::Duration,
};
use tempfile::TempDir;
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    net::UnixListener,
    process::Command,
    sync::Mutex,
    task::{JoinHandle, JoinSet},
    time::timeout,
};

#[cfg(test)]
static FAIL_NEXT_ACCEPT: AtomicBool = AtomicBool::new(false);
#[cfg(test)]
static LATCH_ON_RESPONSE: AtomicBool = AtomicBool::new(false);
#[cfg(test)]
static FAIL_START_CLEANUP: AtomicBool = AtomicBool::new(false);
#[cfg(test)]
pub(crate) fn inject_accept_failure() {
    FAIL_NEXT_ACCEPT.store(true, Ordering::Relaxed);
}

type Result<T> = std::result::Result<T, Box<dyn std::error::Error + Send + Sync>>;
struct Worker {
    channel: channel::Channel,
    _directory: TempDir,
}
struct Drivers {
    workers: Mutex<BTreeMap<String, Arc<Mutex<Option<Worker>>>>>,
    binary: PathBuf,
    verification_path: String,
    starts_enabled: AtomicBool,
    records: PathBuf,
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
}
pub(crate) struct Control {
    drivers: Arc<Drivers>,
    task: StdMutex<Option<JoinHandle<()>>>,
    socket: PathBuf,
    _lock: File,
}
impl Control {
    pub(crate) async fn setup(
        base: Option<PathBuf>,
        binary: std::io::Result<PathBuf>,
        verification_path: String,
    ) -> Option<Self> {
        let (Some(base), Ok(binary)) = (base, binary) else {
            log::warn!("Desktop control unavailable: startup paths unavailable");
            return None;
        };
        match Self::bind(base, binary, verification_path).await {
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
            starts_enabled: AtomicBool::new(false),
            records: directory,
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
                let (stream, _) = match accepted {
                    Ok(connection) => connection,
                    Err(error) => {
                        log::warn!("Desktop control accept failed: {error}");
                        tokio::time::sleep(Duration::from_millis(100)).await;
                        continue;
                    }
                };
                if requests.len() >= 16 {
                    requests.join_next().await;
                }
                let state = state.clone();
                requests.spawn(async move {
                    let (input, mut output) = stream.into_split();
                    let mut line = String::new();
                    let read = timeout(
                        Duration::from_secs(3),
                        BufReader::new(input.take(16384)).read_line(&mut line),
                    )
                    .await;
                    if !matches!(read, Ok(Ok(_))) || !line.ends_with('\n') {
                        return;
                    }
                    let result = match serde_json::from_str(&line) {
                        Ok(request) => state.request(request).await,
                        Err(error) => Err(error.into()),
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
    #[cfg(test)]
    pub(crate) fn enable_fixture_starts(&self) {
        self.drivers.starts_enabled.store(true, Ordering::Relaxed);
    }
    pub(crate) async fn shutdown(&self) {
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
            .values()
            .cloned()
            .collect();
        for slot in slots {
            if let Some(mut worker) = slot.lock().await.take() {
                if let Err(error) = worker.channel.close().await {
                    log::error!("Driver shutdown failed: {error}");
                }
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
impl Drivers {
    async fn request(&self, request: Request) -> Result<Value> {
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
        if request.action == "fixture-latch-on-response" {
            LATCH_ON_RESPONSE.store(true, Ordering::Relaxed);
            return Ok(json!({"armed": true}));
        }
        #[cfg(test)]
        if request.action == "fixture-dialog" {
            let mut fixture = grants::FIXTURE_DIALOG.lock().unwrap();
            if let Some(mode) = request.tool.as_deref() {
                fixture.0 = match mode {
                    "allow" => "allow",
                    "real" => "real",
                    _ => "deny",
                };
                grants::DECLINED.lock().unwrap().clear();
            }
            let texts: serde_json::Map<String, Value> =
                ["observe", "launch", "pointer", "keyboard", "other"]
                    .map(|class| {
                        (
                            class.to_owned(),
                            json!(grants::dialog_text("com.apple.finder", class)),
                        )
                    })
                    .into_iter()
                    .collect();
            return Ok(json!({"dialogs": fixture.1, "texts": texts}));
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
            "resolve" | "fixture-target" | "fixture-grant" | "fixture-revoke"
        ) {
            let tool = request.tool.as_deref().unwrap_or_default();
            let arguments = request.arguments.unwrap_or(Value::Null);
            let mut result = target::resolve(tool, &arguments, request.instance.as_ref());
            let value = &result["value"];
            let tuple =
                [&value["bundle_id"], &value["requirement"], &value["class"]].map(Value::as_str);
            if let [Some(bundle), Some(requirement), Some(class)] = tuple {
                match request.action.as_str() {
                    "resolve" => {
                        if let Err(reason) = grants::check(bundle, requirement, class) {
                            let reason = if reason == "app_action_not_authorized" {
                                grants::ask_owner(bundle, requirement, class)
                            } else {
                                reason
                            };
                            result = json!({"reason": reason, "class": class, "bundle_id": bundle});
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
                    "fixture-target" => {}
                    _ => return Err("Unknown Desktop control action".into()),
                }
            } else if request.action != "resolve" && !cfg!(test) {
                return Err("Unknown Desktop control action".into());
            }
            result["call_id"] = json!(request.call_id);
            return Ok(result);
        }
        let directory = self.records.join("workers").join(&request.worker);
        if matches!(request.action.as_str(), "start" | "stop") {
            record::directory(&self.records, &request.worker, true)?;
        }
        if request.action == "stop" {
            record::latch(&directory)?;
        }
        if request.action == "start" {
            record::ensure_enabled(&directory)?;
        }
        if !self.starts_enabled.load(Ordering::Relaxed) {
            let reason = "Driver control unavailable until worker authorization is enforced";
            return match request.action.as_str() {
                "start" => Err(reason.into()),
                "status" | "stop" => {
                    Ok(json!({"state": "unavailable", "reason": reason, "pid": null}))
                }
                _ => Err("Unknown Desktop control action".into()),
            };
        }
        let worker_id = request.worker.clone();
        let slot = {
            let mut slots = self.workers.lock().await;
            if request.action != "start" && !slots.contains_key(&worker_id) {
                return match request.action.as_str() {
                    "status" | "stop" => Ok(json!({"state": "stopped", "pid": null})),
                    _ => Err("Unknown Desktop control action".into()),
                };
            }
            slots.entry(worker_id.clone()).or_default().clone()
        };
        let mut worker = slot.lock().await;
        let result: Result<()> = async {
            match request.action.as_str() {
                "start" => {
                    let mut starting = record::Starting::begin(&directory)?;
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
                            .tempdir_in(
                                request
                                    .work_dir
                                    .ok_or("workDir is required")?
                                    .canonicalize()?,
                            )?;
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
                            ],
                        )
                        .await?;
                        *worker = Some(Worker {
                            channel,
                            _directory: directory,
                        });
                    }
                    let pid = worker.as_ref().unwrap().channel.pid;
                    if let Err(error) = record::publish(&directory, pid)
                        .and_then(|_| record::ensure_enabled(&directory))
                    {
                        starting.preserve();
                        let _cleanup: Result<()> = async {
                            #[cfg(test)]
                            if FAIL_START_CLEANUP.swap(false, Ordering::Relaxed) {
                                return Err("Fixture start cleanup failed".into());
                            }
                            worker.as_mut().unwrap().channel.close().await?;
                            Ok(())
                        }
                        .await;
                        record::verify_gone(pid)?;
                        starting.cleanup_verified();
                        return Err(error);
                    }
                }
                "stop" => {
                    if let Some(worker) = worker.as_mut() {
                        let pid = worker.channel.pid;
                        if worker.channel.running() {
                            record::verify(&directory, pid)
                                .map_err(|error| format!("stop_unconfirmed: {error}"))?;
                        }
                        worker
                            .channel
                            .close()
                            .await
                            .map_err(|error| format!("stop_unconfirmed: {error}"))?;
                        record::verify_gone(pid)?;
                    }
                    *worker = None;
                }
                "status" => {}
                _ => return Err("Unknown Desktop control action".into()),
            }
            if let Some(worker) = worker.as_mut() {
                let pid = worker.channel.pid;
                #[cfg(test)]
                if request.action == "start" && LATCH_ON_RESPONSE.swap(false, Ordering::Relaxed) {
                    record::latch(&directory)?;
                }
                let valid = record::directory(&self.records, &request.worker, false)
                    .and_then(|_| record::ensure_enabled(&directory))
                    .and_then(|_| record::verify(&directory, pid));
                if let Err(error) = valid {
                    if request.action == "start" {
                        worker
                            .channel
                            .close()
                            .await
                            .map_err(|error| format!("stop_unconfirmed: {error}"))?;
                        record::verify_gone(pid)?;
                    }
                    return Err(error);
                }
            }
            Ok(())
        }
        .await;
        if worker
            .as_mut()
            .is_some_and(|worker| !worker.channel.running())
        {
            *worker = None;
        }
        if worker.is_none() {
            let mut slots = self.workers.lock().await;
            // The map and this request must be the only owners before removal.
            if Arc::strong_count(&slot) == 2 {
                slots.remove(&worker_id);
            }
        }
        result?;
        Ok(match worker.as_ref() {
            Some(worker) => json!({"state": "running", "pid": worker.channel.pid}),
            None => json!({"state": "stopped", "pid": null}),
        })
    }
}
