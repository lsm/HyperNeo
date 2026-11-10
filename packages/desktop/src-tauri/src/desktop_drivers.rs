use cua_driver_sdk::{
    EmbeddedCuaDriverHost, EmbeddedDriverHostOptions, EmbeddedEnvironmentVariable,
};
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
pub(crate) fn inject_accept_failure() {
    FAIL_NEXT_ACCEPT.store(true, Ordering::Relaxed);
}

type Result<T> = std::result::Result<T, Box<dyn std::error::Error + Send + Sync>>;
struct Worker {
    host: Arc<EmbeddedCuaDriverHost>,
    _directory: TempDir,
}
struct Drivers {
    workers: Mutex<BTreeMap<String, Arc<Mutex<Option<Worker>>>>>,
    binary: PathBuf,
    verification_path: String,
    starts_enabled: AtomicBool,
}
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Request {
    action: String,
    worker: String,
    work_dir: Option<PathBuf>,
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
            if let Some(worker) = slot.lock().await.take() {
                if let Err(error) = worker.host.clone().stop().await {
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
        if !self.starts_enabled.load(Ordering::Relaxed) {
            let reason = "Driver control unavailable until worker authorization is enforced";
            return match request.action.as_str() {
                "start" => Err(reason.into()),
                "status" | "stop" => Ok(
                    json!({"state": "unavailable", "reason": reason, "pid": null, "socket": null}),
                ),
                _ => Err("Unknown Desktop control action".into()),
            };
        }
        let slot = self
            .workers
            .lock()
            .await
            .entry(request.worker.clone())
            .or_default()
            .clone();
        let mut worker = slot.lock().await;
        match request.action.as_str() {
            "start" => {
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
                let version = timeout(
                    Duration::from_secs(5),
                    Command::new(&self.binary)
                        .arg("--version")
                        .env_clear()
                        .kill_on_drop(true)
                        .output(),
                )
                .await
                .map_err(|_| "Driver version validation timed out")??;
                if !version.status.success() || version.stdout != b"cua-driver 0.44.0\n" {
                    return Err("Driver version validation failed".into());
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
                    let host = EmbeddedCuaDriverHost::with_options(EmbeddedDriverHostOptions {
                        binary_path: self.binary.to_str().ok_or("Invalid driver path")?.into(),
                        host_bundle_id: "io.hyperneo.app".into(),
                        socket_path: Some(
                            directory
                                .path()
                                .join("d.sock")
                                .to_str()
                                .ok_or("Invalid socket path")?
                                .into(),
                        ),
                        startup_timeout_ms: Some(10000),
                        shutdown_timeout_ms: Some(2000),
                        permission_mode: None,
                        capability_manifest_path: None,
                        approve_capability_manifest: false,
                        session_policy_path: None,
                        approve_session_policy: false,
                        dangerously_bypass_approvals: false,
                        environment: [
                            ("HOME", home),
                            ("TMPDIR", home),
                            ("CUA_DRIVER_RS_HOME", home),
                            ("CUA_DRIVER_RS_TELEMETRY_ENABLED", "0"),
                            ("CUA_DRIVER_RS_UPDATE_CHECK", "0"),
                        ]
                        .into_iter()
                        .map(|(name, value)| EmbeddedEnvironmentVariable {
                            name: name.into(),
                            value: value.into(),
                        })
                        .collect(),
                        inherit_stderr: false,
                        no_overlay: true,
                        capture_stderr: false,
                    })?;
                    *worker = Some(Worker {
                        host,
                        _directory: directory,
                    });
                }
                worker.as_ref().unwrap().host.clone().start().await?;
            }
            "stop" => {
                if let Some(worker) = worker.as_ref() {
                    worker.host.clone().stop().await?;
                }
                *worker = None;
            }
            "status" => {}
            _ => return Err("Unknown Desktop control action".into()),
        }
        Ok(match worker.as_ref() {
            Some(worker) => {
                let connection = worker.host.connection();
                json!({"state": format!("{:?}", worker.host.state()).to_lowercase(), "pid": connection.as_ref().map(|c| c.pid), "socket": connection.map(|c| c.socket_path)})
            }
            None => json!({"state": "stopped", "pid": null, "socket": null}),
        })
    }
}
