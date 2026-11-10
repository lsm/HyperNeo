use cua_driver_sdk::{
    EmbeddedCuaDriverHost, EmbeddedDriverHostOptions, EmbeddedEnvironmentVariable,
};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    fs::{File, OpenOptions},
    os::unix::fs::{DirBuilderExt, FileTypeExt, MetadataExt, OpenOptionsExt, PermissionsExt},
    path::PathBuf,
    sync::Arc,
    time::Duration,
};
use tempfile::TempDir;
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    net::UnixListener,
    process::Command,
    sync::Mutex,
    task::JoinHandle,
    time::timeout,
};

type Result<T> = std::result::Result<T, Box<dyn std::error::Error + Send + Sync>>;
struct Worker {
    host: Arc<EmbeddedCuaDriverHost>,
    _directory: TempDir,
}
struct Drivers {
    workers: BTreeMap<String, Worker>,
    binary: PathBuf,
    verification_path: String,
}
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Request {
    action: String,
    worker: String,
    work_dir: Option<PathBuf>,
}
pub(crate) struct Control {
    drivers: Arc<Mutex<Drivers>>,
    task: JoinHandle<()>,
    socket: PathBuf,
    _lock: File,
}
impl Control {
    pub(crate) async fn bind(
        base: PathBuf,
        binary: PathBuf,
        verification_path: String,
    ) -> Result<Self> {
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
            return Err("Desktop control is already running".into());
        }
        let socket = directory.join("control.sock");
        if let Ok(metadata) = socket.symlink_metadata() {
            if !metadata.file_type().is_socket() {
                return Err("Invalid Desktop control endpoint".into());
            }
            std::fs::remove_file(&socket)?;
        }
        let listener = UnixListener::bind(&socket)?;
        let drivers = Arc::new(Mutex::new(Drivers {
            workers: BTreeMap::new(),
            binary,
            verification_path,
        }));
        let state = drivers.clone();
        let task = tokio::spawn(async move {
            while let Ok((stream, _)) = listener.accept().await {
                let (input, mut output) = stream.into_split();
                let mut line = String::new();
                let read = timeout(
                    Duration::from_secs(3),
                    BufReader::new(input.take(16384)).read_line(&mut line),
                )
                .await;
                if !matches!(read, Ok(Ok(_))) || !line.ends_with('\n') {
                    continue;
                }
                let result = match serde_json::from_str(&line) {
                    Ok(request) => state.lock().await.request(request).await,
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
            }
        });
        Ok(Self {
            drivers,
            task,
            socket,
            _lock: lock,
        })
    }
    pub(crate) async fn shutdown(&self) {
        self.task.abort();
        for worker in self.drivers.lock().await.workers.values() {
            if let Err(error) = worker.host.clone().stop().await {
                log::error!("Driver shutdown failed: {error}");
            }
        }
        let _ = std::fs::remove_file(&self.socket);
    }
}
impl Drop for Control {
    fn drop(&mut self) {
        self.task.abort();
        let _ = std::fs::remove_file(&self.socket);
    }
}
impl Drivers {
    async fn request(&mut self, request: Request) -> Result<Value> {
        if request.worker.is_empty()
            || request.worker.len() > 64
            || !request
                .worker
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        {
            return Err("Invalid worker identifier".into());
        }
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
                    .await??
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
                .await??;
                if !version.status.success() || version.stdout != b"cua-driver 0.44.0\n" {
                    return Err("Driver version validation failed".into());
                }
                if !self.workers.contains_key(&request.worker) {
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
                    self.workers.insert(
                        request.worker.clone(),
                        Worker {
                            host,
                            _directory: directory,
                        },
                    );
                }
                self.workers[&request.worker].host.clone().start().await?;
            }
            "stop" => {
                if let Some(worker) = self.workers.get(&request.worker) {
                    worker.host.clone().stop().await?;
                }
                self.workers.remove(&request.worker);
            }
            "status" => {}
            _ => return Err("Unknown Desktop control action".into()),
        }
        Ok(match self.workers.get(&request.worker) {
            Some(worker) => {
                let connection = worker.host.connection();
                json!({"state": format!("{:?}", worker.host.state()).to_lowercase(), "pid": connection.as_ref().map(|c| c.pid), "socket": connection.map(|c| c.socket_path)})
            }
            None => json!({"state": "stopped", "pid": null, "socket": null}),
        })
    }
}
