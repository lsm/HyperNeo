use tauri::{AppHandle, Manager, Runtime, WebviewUrl, WebviewWindowBuilder};

pub(crate) fn ready_or_show<R: Runtime>(app: &AppHandle<R>) -> bool {
    let Some(status) = crate::desktop_permissions::desktop_permission_status() else {
        return true;
    };
    if status.accessibility && status.screen_recording {
        return true;
    }
    let handle = app.clone();
    if let Err(error) = app.run_on_main_thread(move || {
        if let Err(error) = show(&handle) {
            log::error!("Could not show desktop permissions: {error}");
        }
    }) {
        log::error!("Could not schedule desktop permissions: {error}");
    }
    false
}

fn show<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    if let Some(window) = app.get_webview_window("permissions") {
        window.show()?;
        window.set_focus()?;
        return Ok(());
    }
    WebviewWindowBuilder::new(
        app,
        "permissions",
        WebviewUrl::App("permissions.html".into()),
    )
    .title("Desktop permissions")
    .inner_size(620.0, 560.0)
    .center()
    .build()?;
    Ok(())
}
