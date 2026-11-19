use tauri::{AppHandle, Manager, Runtime, WebviewUrl, WebviewWindowBuilder};

const PERMISSIONS_PAGE: &str = "permissions.html";

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
    WebviewWindowBuilder::new(app, "permissions", WebviewUrl::App(PERMISSIONS_PAGE.into()))
        .title("Desktop permissions")
        .inner_size(620.0, 560.0)
        .center()
        .build()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    #[test]
    fn visible_permission_window_is_not_raised_again() {
        let raised = std::cell::Cell::new(0);
        let raise = || {
            raised.set(raised.get() + 1);
            Ok::<(), ()>(())
        };
        super::show_if_hidden(true, raise).unwrap();
        assert_eq!(raised.get(), 0);
        super::show_if_hidden(false, raise).unwrap();
        assert_eq!(raised.get(), 1);
    }

    #[test]
    fn release_bundle_contains_the_permissions_page_at_its_window_url() {
        let context: tauri::Context<tauri::Wry> = tauri::generate_context!();
        let assets = context.assets();
        assert!(assets.get(&super::PERMISSIONS_PAGE.into()).is_some());
        assert!(assets.get(&"permissions.js".into()).is_some());
        assert!(assets.get(&"loading/permissions.html".into()).is_none());
    }
}
