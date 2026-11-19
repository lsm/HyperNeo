use tauri::{AppHandle, Runtime, WebviewUrl, WebviewWindowBuilder};

pub(crate) fn show_if_needed<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let Some(status) = crate::desktop_permissions::desktop_permission_status() else {
        return Ok(());
    };
    if status.accessibility && status.screen_recording {
        return Ok(());
    }
    WebviewWindowBuilder::new(app, "permissions", WebviewUrl::App("permissions.html".into()))
        .title("Desktop permissions")
        .inner_size(620.0, 560.0)
        .center()
        .build()?;
    Ok(())
}
