use cua_driver_sdk::{
    EmbeddedCuaDriverHost, EmbeddedDriverConnection, EmbeddedDriverHostOptions,
    EmbeddedEnvironmentVariable,
};
use serde_json::{json, Value};
use std::{
    io::ErrorKind,
    os::unix::fs::PermissionsExt,
    sync::atomic::{AtomicBool, Ordering},
    time::Duration,
};
use tauri::{webview::PageLoadEvent, Manager};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::Command,
    time::timeout,
};

type ProofResult<T> = Result<T, Box<dyn std::error::Error + Send + Sync>>;

static STARTED: AtomicBool = AtomicBool::new(false);

pub fn run() {
    let exit_after_load = std::env::var("CUA_PROOF_EXIT_AFTER_LOAD").as_deref() == Ok("1");
    tauri::Builder::default()
        .on_page_load(move |webview, payload| {
            if exit_after_load
                && webview.label() == "main"
                && payload.event() == PageLoadEvent::Finished
            {
                println!("Proof window loaded");
                webview.app_handle().exit(0);
            }
        })
        .invoke_handler(tauri::generate_handler![check_once])
        .run(tauri::generate_context!())
        .expect("start proof window");
}

#[tauri::command]
async fn check_once(app: tauri::AppHandle) -> Result<String, String> {
    if STARTED.swap(true, Ordering::SeqCst) {
        return Err("The permission check has already started.".into());
    }
    check(&app.config().identifier)
        .await
        .map_err(|error| error.to_string())
}

async fn check(bundle_id: &str) -> ProofResult<String> {
    let directory = tempfile::Builder::new()
        .prefix("hyperneo-proof-")
        .permissions(std::fs::Permissions::from_mode(0o700))
        .tempdir_in("/private/tmp")?;
    let socket = directory.path().join("driver.sock");
    let home = directory.path().to_str().ok_or("invalid proof directory")?;
    let environment = [
        ("HOME", home),
        ("TMPDIR", home),
        ("CUA_DRIVER_RS_HOME", home),
        ("CUA_DRIVER_RS_TELEMETRY_ENABLED", "0"),
        ("CUA_DRIVER_RS_UPDATE_CHECK", "0"),
    ];
    let binary = std::env::current_exe()?.with_file_name("cua-driver");
    let host = EmbeddedCuaDriverHost::with_options(EmbeddedDriverHostOptions {
        binary_path: binary.to_str().ok_or("invalid driver path")?.into(),
        host_bundle_id: bundle_id.into(),
        socket_path: Some(socket.to_str().ok_or("invalid socket path")?.into()),
        startup_timeout_ms: Some(15_000),
        shutdown_timeout_ms: Some(3_000),
        permission_mode: None,
        capability_manifest_path: None,
        approve_capability_manifest: false,
        session_policy_path: None,
        approve_session_policy: false,
        dangerously_bypass_approvals: false,
        environment: environment
            .iter()
            .map(|&(name, value)| EmbeddedEnvironmentVariable {
                name: name.into(),
                value: value.into(),
            })
            .collect(),
        inherit_stderr: false,
        no_overlay: true,
        capture_stderr: false,
    })?;
    let connection = host.clone().start().await?;
    let result = permissions(&connection, &environment).await;
    let status = match &result {
        Ok(status) => status.to_string(),
        Err(error) => format!("Permission check failed: {error}"),
    };
    println!("{status}");
    let stop = host.stop().await;
    let pid_gone = unsafe { libc::kill(connection.pid as libc::pid_t, 0) } == -1
        && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH);
    let socket_gone =
        matches!(socket.symlink_metadata(), Err(error) if error.kind() == ErrorKind::NotFound);
    let report = format!(
        "{status}\n\nApp PID: {}\nDriver PID: {}\nSocket: {}\nDriver stopped: {}\nDriver PID gone: {pid_gone}\nSocket gone: {socket_gone}",
        std::process::id(),
        connection.pid,
        socket.display(),
        stop.is_ok(),
    );
    println!("{report}");
    if let Err(error) = stop {
        return Err(format!("{report}\nStop failed: {error}").into());
    }
    if result.is_err() || !pid_gone || !socket_gone {
        return Err(report.into());
    }
    Ok(report)
}

async fn permissions(
    connection: &EmbeddedDriverConnection,
    environment: &[(&str, &str)],
) -> ProofResult<Value> {
    use std::process::Stdio;

    let mut proxy = Command::new(&connection.mcp.command)
        .args(&connection.mcp.args)
        .env_clear()
        .envs(environment.iter().copied())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()?;
    let mut input = proxy.stdin.take().ok_or("MCP input unavailable")?;
    let mut output = BufReader::new(proxy.stdout.take().ok_or("MCP output unavailable")?).lines();
    let exchange = timeout(Duration::from_secs(10), async {
        let initialize = json!({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
            "protocolVersion": connection.mcp_protocol_version,
            "capabilities": {},
            "clientInfo": {"name": "hyperneo-proof", "version": "1"}
        }});
        input
            .write_all(format!("{initialize}\n").as_bytes())
            .await?;
        read_response(&mut output, 1).await?;
        let initialized = json!({"jsonrpc": "2.0", "method": "notifications/initialized"});
        let call = json!({"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": {
            "name": "check_permissions", "arguments": {"prompt": false}
        }});
        input
            .write_all(format!("{initialized}\n{call}\n").as_bytes())
            .await?;
        let result = read_response(&mut output, 2).await?;
        let status = &result["structuredContent"];
        if result["isError"] == true
            || !status["accessibility"].is_boolean()
            || !status["screen_recording"].is_boolean()
        {
            return Err("driver did not return both permission booleans".into());
        }
        let source = &status["source"];
        if source["embedded"] != true
            || source["pid"] != connection.pid
            || source["responsible_ppid"] != std::process::id()
        {
            return Err("permission status did not come from the app's direct child".into());
        }
        Ok(json!({
            "accessibility": status["accessibility"],
            "screen_recording": status["screen_recording"],
            "driver_parent_pid": source["responsible_ppid"],
        }))
    })
    .await;
    drop(input);
    match timeout(Duration::from_secs(2), proxy.wait()).await {
        Ok(status) => {
            if !status?.success() && exchange.as_ref().is_ok_and(Result::is_ok) {
                return Err("MCP proxy exited unsuccessfully".into());
            }
        }
        Err(_) => proxy.kill().await?,
    }
    exchange?
}

async fn read_response(
    output: &mut tokio::io::Lines<BufReader<tokio::process::ChildStdout>>,
    id: u64,
) -> ProofResult<Value> {
    while let Some(line) = output.next_line().await? {
        let response: Value = serde_json::from_str(&line)?;
        if response["id"] == id {
            return response
                .get("result")
                .cloned()
                .ok_or_else(|| format!("MCP request {id} failed: {}", response["error"]).into());
        }
    }
    Err(format!("MCP closed before replying to request {id}").into())
}
