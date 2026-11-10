#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DesktopPermissionStatus {
    accessibility: bool,
    screen_recording: bool,
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
