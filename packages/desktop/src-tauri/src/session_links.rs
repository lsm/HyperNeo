use tauri::{plugin, AppHandle, Runtime, Url};

fn is_session_url(url: &Url) -> bool {
    if !url.username().is_empty() || url.password().is_some() {
        return false;
    }
    if matches!(url.scheme(), "http" | "https") {
        return url.has_host();
    }
    let prefix = match (url.scheme(), url.host_str()) {
        ("claude", Some("claude.ai")) => "/epitaxy/",
        ("codex", Some("threads")) | ("ghapp", Some("sessions")) => "/",
        _ => return false,
    };
    url.port().is_none()
        && url.query().is_none()
        && url.fragment().is_none()
        && url
            .path()
            .strip_prefix(prefix)
            .is_some_and(|id| !id.is_empty() && !id.contains('/'))
}

#[tauri::command]
async fn open<R: Runtime>(app: AppHandle<R>, url: String) -> Result<(), String> {
    let url = Url::parse(&url).map_err(|_| "Invalid session link")?;
    if !is_session_url(&url) {
        return Err("Unsupported session link".into());
    }

    #[cfg(target_os = "macos")]
    {
        let _ = app;
        let status = tokio::process::Command::new("/usr/bin/open")
            .arg(url.as_str())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .await
            .map_err(|error| error.to_string())?;
        status
            .success()
            .then_some(())
            .ok_or_else(|| "Could not open the session app".into())
    }

    #[cfg(not(target_os = "macos"))]
    {
        use tauri_plugin_shell::ShellExt;
        #[allow(deprecated)]
        let result = app.shell().open(url.as_str(), None);
        result.map_err(|error| error.to_string())
    }
}

pub fn plugin<R: Runtime>() -> plugin::TauriPlugin<R> {
    plugin::Builder::new("session-links")
        .invoke_handler(tauri::generate_handler![open])
        .build()
}
