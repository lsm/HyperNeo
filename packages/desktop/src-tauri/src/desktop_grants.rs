use objc2_app_kit::{NSAlert, NSApplication};
use objc2_foundation::NSString;
use security_framework::{
    access_control::{ProtectionMode, SecAccessControl},
    passwords::{
        delete_generic_password_options, generic_password, set_generic_password_options,
        PasswordOptions,
    },
};
use std::{collections::BTreeSet, sync::Mutex};

static PENDING: Mutex<BTreeSet<String>> = Mutex::new(BTreeSet::new());
#[cfg(test)]
pub(super) static FIXTURE_DIALOG: Mutex<(&str, u64)> = Mutex::new(("deny", 0));

const GROUP: &str = "P5R65T296V.io.hyperneo.app";
#[cfg(not(test))]
const SERVICE: &str = "io.hyperneo.desktop.grant";
#[cfg(test)]
const SERVICE: &str = "io.hyperneo.desktop.grant.fixture";
const NOT_FOUND: i32 = -25300;

fn options(requirement: &str, class: &str) -> PasswordOptions {
    let mut options =
        PasswordOptions::new_generic_password(SERVICE, &format!("{class}\n{requirement}"));
    options.use_protected_keychain();
    options.set_access_group(GROUP);
    options.set_access_synchronized(Some(false));
    options
}

pub(super) fn check(bundle_id: &str, requirement: &str, class: &str) -> Result<(), &'static str> {
    match generic_password(options(requirement, class)) {
        Ok(stored) if stored == bundle_id.as_bytes() => Ok(()),
        Ok(_) => Err("app_action_not_authorized"),
        Err(error) if error.code() == NOT_FOUND => Err("app_action_not_authorized"),
        Err(_) => Err("guards_unavailable"),
    }
}

pub(super) fn record(
    bundle_id: &str,
    requirement: &str,
    class: &str,
    keep: bool,
) -> Result<(), String> {
    let result = if keep {
        let mut options = options(requirement, class);
        let device_only = ProtectionMode::AccessibleAfterFirstUnlockThisDeviceOnly;
        options.set_access_control(
            SecAccessControl::create_with_protection(Some(device_only), 0)
                .map_err(|error| format!("grant_store_refused: {}", error.code()))?,
        );
        set_generic_password_options(bundle_id.as_bytes(), options)
    } else {
        delete_generic_password_options(options(requirement, class))
    };
    result.map_err(|error| format!("grant_store_refused: {}", error.code()))
}

fn owner_allows(bundle_id: &str, class: &str) -> bool {
    #[cfg(test)]
    {
        let mut fixture = FIXTURE_DIALOG.lock().unwrap();
        fixture.1 += 1;
        if fixture.0 != "real" {
            return fixture.0 == "allow";
        }
    }
    let action = match class {
        "observe" => "see its windows",
        "launch" => "open it",
        "pointer" => "click and scroll in it",
        _ => "type into it",
    };
    let message = format!(
        "A HyperNeo worker asked to {action}.\n\nApp: {bundle_id}\n\nThis lasts until you revoke it. Each action still checks the app, focus and idle time."
    );
    dispatch2::run_on_main(|mtm| {
        let alert = NSAlert::new(mtm);
        alert.setMessageText(&NSString::from_str("Allow HyperNeo to control an app?"));
        alert.setInformativeText(&NSString::from_str(&message));
        alert.addButtonWithTitle(&NSString::from_str("Don't Allow"));
        alert.addButtonWithTitle(&NSString::from_str("Allow"));
        #[allow(deprecated)]
        NSApplication::sharedApplication(mtm).activateIgnoringOtherApps(true);
        alert.runModal() == 1001
    })
}

pub(super) fn ask_owner(bundle_id: &str, requirement: &str, class: &str) {
    if bundle_id == "io.hyperneo.app" {
        return;
    }
    let key = format!("{class}\n{requirement}");
    if !PENDING.lock().unwrap().insert(key.clone()) {
        return;
    }
    let (bundle_id, requirement, class) = (
        bundle_id.to_owned(),
        requirement.to_owned(),
        class.to_owned(),
    );
    std::thread::spawn(move || {
        if owner_allows(&bundle_id, &class) {
            if let Err(error) = record(&bundle_id, &requirement, &class, true) {
                log::warn!("Desktop grant was approved but not stored: {error}");
            }
        }
        PENDING.lock().unwrap().remove(&key);
    });
}
