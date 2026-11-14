use objc2_app_kit::{NSAlert, NSApplication};
use objc2_foundation::NSString;
use security_framework::{
    access_control::{ProtectionMode, SecAccessControl},
    passwords::{
        delete_generic_password_options, generic_password, set_generic_password_options,
        PasswordOptions,
    },
};
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::Mutex,
    time::{Duration, Instant},
};

pub(super) static ASKS: Mutex<(BTreeSet<String>, BTreeMap<String, Instant>)> =
    Mutex::new((BTreeSet::new(), BTreeMap::new()));
const DECLINE_COOLDOWN: Duration = Duration::from_secs(10 * 60);
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

pub(super) fn dialog_text(bundle_id: &str, class: &str) -> Option<String> {
    let action = match class {
        "observe" => "see its windows",
        "launch" => "open it",
        "pointer" => "click and scroll in it",
        "keyboard" => "type into it",
        _ => return None,
    };
    Some(format!(
        "A HyperNeo worker asked to {action}.\n\nApp: {bundle_id}\n\nIf you allow it, HyperNeo workers can do this in this app without asking again."
    ))
}

fn owner_allows(bundle_id: &str, class: &str) -> Option<bool> {
    let Some(message) = dialog_text(bundle_id, class) else {
        return Some(false);
    };
    #[cfg(test)]
    let fail = {
        FIXTURE_DIALOG.lock().unwrap().1 += 1;
        loop {
            let mode = FIXTURE_DIALOG.lock().unwrap().0;
            match mode {
                "hold" => {}
                "panic" => break true,
                "real" => break false,
                mode => return Some(mode == "allow"),
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    };
    dispatch2::run_on_main(|mtm| {
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            #[cfg(test)]
            if fail {
                panic!("fixture dialog failed");
            }
            let alert = NSAlert::new(mtm);
            alert.setMessageText(&NSString::from_str("Allow HyperNeo to control an app?"));
            alert.setInformativeText(&NSString::from_str(&message));
            alert.addButtonWithTitle(&NSString::from_str("Don't Allow"));
            alert.addButtonWithTitle(&NSString::from_str("Allow"));
            #[allow(deprecated)]
            NSApplication::sharedApplication(mtm).activateIgnoringOtherApps(true);
            alert.runModal() == 1001
        }))
        .ok()
    })
}

pub(super) fn ask_owner(bundle_id: &str, requirement: &str, class: &str) -> &'static str {
    let key = format!("{class}\n{requirement}");
    {
        let mut asks = ASKS.lock().unwrap();
        let (pending, declined) = &mut *asks;
        #[cfg(test)]
        if FIXTURE_DIALOG.lock().unwrap().0 == "hold" && pending.contains(&key) {
            FIXTURE_DIALOG.lock().unwrap().0 = "deny";
            std::thread::sleep(Duration::from_millis(200));
        }
        if declined
            .get(&key)
            .is_some_and(|at| at.elapsed() < DECLINE_COOLDOWN)
        {
            return "app_action_declined";
        }
        if !pending.insert(key.clone()) {
            return "app_action_not_authorized";
        }
    }
    let (bundle_id, requirement, class) = (
        bundle_id.to_owned(),
        requirement.to_owned(),
        class.to_owned(),
    );
    std::thread::spawn(move || {
        let answer = owner_allows(&bundle_id, &class);
        if answer == Some(true) {
            if let Err(error) = record(&bundle_id, &requirement, &class, true) {
                log::warn!("Desktop grant was approved but not stored: {error}");
            }
        }
        let mut asks = ASKS.lock().unwrap();
        let (pending, declined) = &mut *asks;
        match answer {
            Some(true) => _ = declined.remove(&key),
            Some(false) => _ = declined.insert(key.clone(), Instant::now()),
            None => {}
        }
        pending.remove(&key);
    });
    "app_action_not_authorized"
}
