use cua_driver_sdk::worker::{
    ChannelRequest, ChannelResponse, WorkerInitialization, PRIVATE_WORKER_PROTOCOL_VERSION,
};
use cua_driver_sdk::{ConfiguredDriverOptions, RuntimeAuthorizationOptions, SessionPermissionMode};
use serde_json::Value;
use std::{os::fd::AsRawFd, path::Path, process::Stdio, time::Duration};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    net::UnixStream,
    process::{Child, Command},
    time::timeout,
};

type Result<T> = std::result::Result<T, Box<dyn std::error::Error + Send + Sync>>;
const TRANSPORT_FD: i32 = 3;

pub(super) struct Channel {
    child: Child,
    stream: Option<BufReader<UnixStream>>,
    generation: String,
    next: u64,
    pub(super) pid: u32,
}

impl Channel {
    pub(super) async fn open(binary: &Path, environment: &[(&str, &str)]) -> Result<Self> {
        let (host, inherited) = std::os::unix::net::UnixStream::pair()?;
        let clock = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)?;
        let generation = format!("{}-{}", std::process::id(), clock.as_nanos());
        let mut command = Command::new(binary);
        command
            .arg("__private-worker")
            .arg("--generation")
            .arg(&generation)
            .arg(format!("--transport-fd={TRANSPORT_FD}"))
            .env_clear()
            .envs(environment.iter().copied())
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        let source = inherited.as_raw_fd();
        unsafe {
            command.pre_exec(move || {
                if libc::dup2(source, TRANSPORT_FD) < 0
                    || libc::fcntl(TRANSPORT_FD, libc::F_SETFD, 0) < 0
                {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
        let child = command.spawn()?;
        drop(inherited);
        host.set_nonblocking(true)?;
        let pid = child.id().ok_or("Driver exited at launch")?;
        let mut channel = Self {
            child,
            stream: Some(BufReader::new(UnixStream::from_std(host)?)),
            generation,
            next: 0,
            pid,
        };
        let initialization = serde_json::to_value(WorkerInitialization {
            configured_driver: ConfiguredDriverOptions {
                claude_code_compatibility: false,
                authorization: RuntimeAuthorizationOptions {
                    allowed_modes: vec![SessionPermissionMode::Standard],
                    compatibility_mode: SessionPermissionMode::Standard,
                    compatibility_capability_manifest_path: None,
                    compatibility_bounded_manifest_path: None,
                    unrestricted_acknowledged: false,
                    max_session_ttl_seconds: 3600,
                    max_idle_ttl_seconds: 900,
                },
            },
            host_bundle_id: "io.hyperneo.app".into(),
        })?;
        let ready = timeout(
            Duration::from_secs(10),
            channel.request("initialize", Some(initialization)),
        )
        .await
        .unwrap_or_else(|_| Err("Driver startup timed out".into()));
        let ready = ready.and_then(|ready| {
            if ready["metadata"]["driver_version"] == "0.44.0" {
                Ok(())
            } else {
                Err("Driver version validation failed".into())
            }
        });
        if let Err(error) = ready {
            channel.close().await?;
            return Err(error);
        }
        Ok(channel)
    }

    pub(super) async fn request(
        &mut self,
        operation: &str,
        arguments: Option<Value>,
    ) -> Result<Value> {
        let stream = self.stream.as_mut().ok_or("Driver channel closed")?;
        let request = ChannelRequest {
            protocol_version: PRIVATE_WORKER_PROTOCOL_VERSION,
            request_id: self.next,
            generation: self.generation.clone(),
            operation: operation.into(),
            name: None,
            arguments,
            session_handle: None,
        };
        self.next += 1;
        let mut line = serde_json::to_vec(&request)?;
        line.push(b'\n');
        stream.get_mut().write_all(&line).await?;
        let mut reply = String::new();
        (&mut *stream).take(1 << 20).read_line(&mut reply).await?;
        let response: ChannelResponse = serde_json::from_str(&reply)?;
        if response.request_id != request.request_id || response.generation != self.generation {
            return Err("Driver response does not match its request".into());
        }
        if !response.ok {
            return Err(response
                .error_code
                .unwrap_or_else(|| "driver_error".into())
                .into());
        }
        Ok(response.result.unwrap_or(Value::Null))
    }

    pub(super) fn running(&mut self) -> bool {
        self.stream.is_some() && matches!(self.child.try_wait(), Ok(None))
    }

    pub(super) async fn close(&mut self) -> Result<()> {
        self.stream.take();
        if timeout(Duration::from_secs(2), self.child.wait())
            .await
            .is_err()
        {
            self.child.start_kill()?;
            timeout(Duration::from_secs(2), self.child.wait())
                .await
                .map_err(|_| "stop_unconfirmed: driver did not exit")??;
        }
        Ok(())
    }
}
