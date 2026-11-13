use core_foundation::{
    array::CFArray,
    base::{CFType, TCFType},
    dictionary::{CFDictionary, CFDictionaryRef},
    number::CFNumber,
    string::{CFString, CFStringRef},
    url::CFURL,
};
use core_graphics::window::{
    copy_window_info, kCGNullWindowID, kCGWindowListOptionAll, kCGWindowNumber, kCGWindowOwnerPID,
};
use security_framework::os::macos::code_signing::{
    Flags, GuestAttributes, SecCode, SecRequirement, SecStaticCode,
};
use serde_json::{json, Value};
use std::{ffi::c_void, str::FromStr};

const ANCHOR: &str = "anchor apple or (anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists)";

#[link(name = "Security", kind = "framework")]
extern "C" {
    static kSecCodeInfoIdentifier: CFStringRef;
    static kSecCodeInfoTeamIdentifier: CFStringRef;
    static kSecCodeInfoPList: CFStringRef;
    fn SecCodeCopySigningInformation(
        code: *const c_void,
        flags: u32,
        info: *mut CFDictionaryRef,
    ) -> i32;
    fn SecCodeCopyDesignatedRequirement(
        code: *const c_void,
        flags: u32,
        out: *mut *const c_void,
    ) -> i32;
    fn SecRequirementCopyString(
        requirement: *const c_void,
        flags: u32,
        out: *mut CFStringRef,
    ) -> i32;
}
#[link(name = "CoreServices", kind = "framework")]
extern "C" {
    fn LSCopyApplicationURLsForBundleIdentifier(
        id: CFStringRef,
        error: *mut c_void,
    ) -> *const c_void;
}

pub(super) fn class(tool: &str) -> Option<&'static str> {
    Some(match tool {
        "list_windows" | "get_window_state" | "zoom" => "observe",
        "launch_app" => "launch",
        "click" | "double_click" | "right_click" | "drag" | "scroll" => "pointer",
        "type_text" | "press_key" | "set_value" => "keyboard",
        _ => return None,
    })
}

fn started_at(pid: i32) -> Option<(u64, u64)> {
    let mut info: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
    let size = std::mem::size_of_val(&info) as i32;
    let read = unsafe {
        libc::proc_pidinfo(
            pid,
            libc::PROC_PIDTBSDINFO,
            0,
            (&mut info as *mut libc::proc_bsdinfo).cast(),
            size,
        )
    };
    (read == size && info.pbi_pid as i32 == pid)
        .then_some((info.pbi_start_tvsec, info.pbi_start_tvusec))
}

struct Signer {
    bundle_id: String,
    team_id: Option<String>,
    requirement: String,
}

fn string(value: Option<CFType>) -> Option<String> {
    value
        .and_then(|value| value.downcast::<CFString>())
        .map(|value| value.to_string())
}

fn signer(code: *const c_void) -> Result<Signer, &'static str> {
    unsafe {
        let mut info: CFDictionaryRef = std::ptr::null();
        if SecCodeCopySigningInformation(code, 2, &mut info) != 0 || info.is_null() {
            return Err("target_unverified");
        }
        let info: CFDictionary<CFString, CFType> = TCFType::wrap_under_create_rule(info);
        let field = |key: CFStringRef| {
            info.find(CFString::wrap_under_get_rule(key))
                .map(|value| value.clone())
        };
        let identifier = string(field(kSecCodeInfoIdentifier)).ok_or("target_unverified")?;
        let bundle = field(kSecCodeInfoPList)
            .and_then(|plist| plist.downcast::<CFDictionary>())
            .and_then(|plist| {
                plist
                    .find(CFString::from_static_string("CFBundleIdentifier").as_CFTypeRef())
                    .map(|value| CFType::wrap_under_get_rule(*value))
            });
        match string(bundle) {
            Some(bundle) if bundle == identifier => {}
            Some(_) => return Err("target_mismatch"),
            None => return Err("target_unverified"),
        }
        let mut requirement = std::ptr::null();
        if SecCodeCopyDesignatedRequirement(code, 0, &mut requirement) != 0 || requirement.is_null()
        {
            return Err("target_unverified");
        }
        let requirement: SecRequirement = TCFType::wrap_under_create_rule(requirement as _);
        let mut text: CFStringRef = std::ptr::null();
        if SecRequirementCopyString(requirement.as_concrete_TypeRef() as _, 0, &mut text) != 0
            || text.is_null()
        {
            return Err("target_unverified");
        }
        let text = CFString::wrap_under_create_rule(text).to_string();
        Ok(Signer {
            bundle_id: identifier,
            team_id: string(field(kSecCodeInfoTeamIdentifier)),
            requirement: text,
        })
    }
}

fn owner(window: u32) -> Option<i32> {
    let owned = copy_window_info(kCGWindowListOptionAll, kCGNullWindowID)?;
    let windows: CFArray<CFDictionary<CFString, CFType>> =
        unsafe { CFArray::wrap_under_get_rule(owned.as_concrete_TypeRef()) };
    let number = |entry: &CFDictionary<CFString, CFType>, key| {
        entry
            .find(unsafe { CFString::wrap_under_get_rule(key) })
            .and_then(|value| value.downcast::<CFNumber>())
            .and_then(|value| value.to_i64())
    };
    windows.iter().find_map(|entry| {
        (number(&entry, unsafe { kCGWindowNumber }) == Some(window as i64))
            .then(|| number(&entry, unsafe { kCGWindowOwnerPID }).map(|pid| pid as i32))
            .flatten()
    })
}

pub(super) fn resolve(tool: &str, arguments: &Value, instance: Option<&Value>) -> Value {
    let Some(class) = class(tool) else {
        return json!({"reason": "tool_not_allowed"});
    };
    let refuse = |reason: &str| json!({"reason": reason, "class": class});
    let anchor = SecRequirement::from_str(ANCHOR).expect("valid anchor requirement");
    if class == "launch" {
        let Some(bundle) = arguments["bundle_id"].as_str() else {
            return refuse("target_unverified");
        };
        let urls = unsafe {
            LSCopyApplicationURLsForBundleIdentifier(
                CFString::new(bundle).as_concrete_TypeRef(),
                std::ptr::null_mut(),
            )
        };
        if urls.is_null() {
            return refuse("target_unverified");
        }
        let urls: CFArray<CFURL> = unsafe { CFArray::wrap_under_create_rule(urls as _) };
        if urls.len() != 1 {
            return refuse("target_mismatch");
        }
        let url = urls.get(0).unwrap();
        let Ok(code) = SecStaticCode::from_path(&url, Flags::NONE) else {
            return refuse("target_unverified");
        };
        let signer = match signer(code.as_concrete_TypeRef() as _) {
            Ok(signer) if signer.bundle_id == bundle => signer,
            Ok(_) => return refuse("target_mismatch"),
            Err(reason) => return refuse(reason),
        };
        if code
            .check_validity(Flags::STRICT_VALIDATE, &anchor)
            .is_err()
        {
            return refuse("target_unverified");
        }
        return json!({"value": {
            "bundle_id": signer.bundle_id, "team_id": signer.team_id, "requirement": signer.requirement,
            "class": class, "path": url.to_path().map(|path| path.display().to_string())}});
    }
    let Some(pid) = arguments["pid"]
        .as_i64()
        .filter(|pid| *pid > 1 && *pid <= i32::MAX as i64)
        .map(|pid| pid as i32)
    else {
        return refuse("target_unverified");
    };
    let Some(before) = started_at(pid) else {
        return refuse("target_unverified");
    };
    let observed =
        json!({"pid": pid, "startedAt": {"seconds": before.0, "microseconds": before.1}});
    if instance.is_some_and(|expected| expected != &observed) {
        return refuse("target_mismatch");
    }
    let mut attributes = GuestAttributes::new();
    attributes.set_pid(pid);
    let Ok(code) = SecCode::copy_guest_with_attribues(None, &attributes, Flags::NONE) else {
        return refuse("target_unverified");
    };
    let signer = signer(code.as_concrete_TypeRef() as _);
    let verified = code.check_validity(Flags::STRICT_VALIDATE, &anchor).is_ok();
    if started_at(pid) != Some(before) {
        return refuse("target_mismatch");
    }
    let signer = match signer {
        Ok(signer) if verified => signer,
        Ok(_) => return refuse("target_unverified"),
        Err(reason) => return refuse(reason),
    };
    let refuse =
        |reason: &str| json!({"reason": reason, "class": class, "bundle_id": signer.bundle_id});
    let window = match &arguments["window_id"] {
        Value::Null => None,
        value => match value.as_u64().and_then(|window| u32::try_from(window).ok()) {
            Some(window) => Some(window),
            None => return refuse("target_unverified"),
        },
    };
    if let Some(window) = window {
        match owner(window) {
            Some(owner) if owner == pid => {}
            Some(_) => return refuse("target_mismatch"),
            None => return refuse("target_unverified"),
        }
    }
    json!({"value": {"bundle_id": signer.bundle_id, "team_id": signer.team_id, "requirement": signer.requirement,
        "class": class, "instance": observed, "window_id": window}})
}
