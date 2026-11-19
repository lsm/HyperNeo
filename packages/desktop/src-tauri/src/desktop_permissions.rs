#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DesktopPermissionStatus {
    pub(crate) accessibility: bool,
    pub(crate) screen_recording: bool,
}

#[tauri::command]
pub(crate) fn desktop_permission_status() -> Option<DesktopPermissionStatus> {
    #[cfg(target_os = "macos")]
    {
        Some(macos::status())
    }
    #[cfg(not(target_os = "macos"))]
    {
        None
    }
}

#[cfg(target_os = "macos")]
mod macos {
    use super::DesktopPermissionStatus;
    use std::ffi::{c_char, c_void};

    #[link(name = "ApplicationServices", kind = "framework")]
    extern "C" {
        fn AXIsProcessTrusted() -> u8;
    }

    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn dlsym(handle: *mut c_void, symbol: *const c_char) -> *mut c_void;
    }

    fn screen_recording() -> bool {
        // The preflight API first shipped in macOS 10.15. Older hosts report unavailable.
        const RTLD_DEFAULT: *mut c_void = -2_isize as *mut c_void;
        let symbol = unsafe { dlsym(RTLD_DEFAULT, c"CGPreflightScreenCaptureAccess".as_ptr()) };
        if symbol.is_null() {
            return false;
        }
        let preflight = unsafe { std::mem::transmute::<_, unsafe extern "C" fn() -> bool>(symbol) };
        unsafe { preflight() }
    }

    pub(super) fn status() -> DesktopPermissionStatus {
        DesktopPermissionStatus {
            accessibility: unsafe { AXIsProcessTrusted() != 0 },
            screen_recording: screen_recording(),
        }
    }
}

#[tauri::command]
pub(crate) fn open_desktop_permission_settings(permission: &str) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let pane = match permission {
            "accessibility" => "Privacy_Accessibility",
            "screenRecording" => "Privacy_ScreenCapture",
            _ => return Err("Unknown permission".into()),
        };
        std::process::Command::new("/usr/bin/open")
            .arg(format!("x-apple.systempreferences:com.apple.preference.security?{pane}"))
            .spawn()
            .map(|_| ())
            .map_err(|error| error.to_string())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = permission;
        Err("Desktop permissions are only available on macOS".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    fn actions_for(permission: &str) -> Vec<String> {
        let actions = RefCell::new(Vec::new());
        open_desktop_permission_settings_with(
            permission,
            |value| actions.borrow_mut().push(format!("request:{value}")),
            |value| {
                actions.borrow_mut().push(format!("open:{value}"));
                Ok(())
            },
        )
        .unwrap();
        actions.into_inner()
    }

    #[test]
    fn accessibility_requests_access_before_opening_settings() {
        assert_eq!(
            actions_for("accessibility"),
            ["request:accessibility", "open:Privacy_Accessibility"]
        );
    }

    #[test]
    fn screen_recording_requests_access_before_opening_settings() {
        assert_eq!(
            actions_for("screenRecording"),
            ["request:screenRecording", "open:Privacy_ScreenCapture"]
        );
    }
}
