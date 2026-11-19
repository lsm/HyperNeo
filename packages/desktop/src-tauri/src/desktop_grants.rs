use objc2_app_kit::{NSAlert, NSAlertFirstButtonReturn, NSApplication};
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
    sync::{Condvar, Mutex},
    time::{Duration, Instant},
};

pub(super) static ASKS: Mutex<(BTreeSet<String>, BTreeMap<String, Instant>)> =
    Mutex::new((BTreeSet::new(), BTreeMap::new()));
const DECLINE_COOLDOWN: Duration = Duration::from_secs(10 * 60);
static ANSWERED: Condvar = Condvar::new();
#[cfg(not(test))]
const OWNER_WAIT: Duration = Duration::from_secs(45);
#[cfg(test)]
const OWNER_WAIT: Duration = Duration::from_millis(200);
#[cfg(test)]
pub(super) static FIXTURE_DIALOG: Mutex<(&str, u64)> = Mutex::new(("deny", 0));
#[cfg(test)]
static FIXTURE_GRANTS: Mutex<BTreeMap<String, String>> = Mutex::new(BTreeMap::new());

const GROUP: &str = "P5R65T296V.io.hyperneo.app";
#[cfg(not(test))]
const SERVICE: &str = "io.hyperneo.desktop.grant";
#[cfg(test)]
const SERVICE: &str = "io.hyperneo.desktop.grant.fixture";
const NOT_FOUND: i32 = -25300;

fn options(requirement: &str, _class: &str) -> PasswordOptions {
    let mut options =
        PasswordOptions::new_generic_password(SERVICE, &format!("all\n{requirement}"));
    options.use_protected_keychain();
    options.set_access_group(GROUP);
    options.set_access_synchronized(Some(false));
    options
}

pub(super) fn check(bundle_id: &str, requirement: &str, class: &str) -> Result<(), &'static str> {
    #[cfg(test)]
    if let Some(stored) = FIXTURE_GRANTS
        .lock()
        .unwrap()
        .get(&format!("all\n{requirement}"))
    {
        return if stored == bundle_id {
            Ok(())
        } else {
            Err("app_action_not_authorized")
        };
    }
    #[cfg(test)]
    if FIXTURE_DIALOG.lock().unwrap().0.starts_with("mock-") {
        return Err("app_action_not_authorized");
    }
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
    #[cfg(test)]
    if FIXTURE_DIALOG.lock().unwrap().0.starts_with("mock-") {
        let mut grants = FIXTURE_GRANTS.lock().unwrap();
        let key = format!("all\n{requirement}");
        if keep {
            grants.insert(key, bundle_id.to_owned());
        } else {
            grants.remove(&key);
        }
        return Ok(());
    }
    #[cfg(test)]
    if !keep {
        FIXTURE_GRANTS
            .lock()
            .unwrap()
            .remove(&format!("all\n{requirement}"));
    }
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
    match class {
        "observe" | "launch" | "pointer" | "keyboard" => (),
        _ => return None,
    }
    Some(format!(
        "A HyperNeo worker asked to open this app, see its windows, click, scroll and type in it.\n\nApp: {bundle_id}\n\nIf you allow it, HyperNeo workers can do these actions in this app without asking again."
    ))
}

#[cfg(test)]
pub(super) fn admit(bundle_id: &str, requirement: &str, _class: &str) {
    FIXTURE_GRANTS
        .lock()
        .unwrap()
        .insert(format!("all\n{requirement}"), bundle_id.to_owned());
}

fn prepare_alert(alert: &NSAlert, message: &str) {
    alert.setMessageText(&NSString::from_str("Allow HyperNeo to control an app?"));
    alert.setInformativeText(&NSString::from_str(message));
    alert.addButtonWithTitle(&NSString::from_str("Allow"));
    alert
        .addButtonWithTitle(&NSString::from_str("Don't Allow"))
        .setKeyEquivalent(&NSString::from_str("\u{1b}"));
}

#[cfg(test)]
pub(super) fn dialog_buttons() -> Option<Vec<(String, String)>> {
    let message = dialog_text("com.apple.calculator", "launch")?;
    dispatch2::run_on_main(move |mtm| {
        let alert = NSAlert::new(mtm);
        prepare_alert(&alert, &message);
        Some(
            alert
                .buttons()
                .iter()
                .map(|button| {
                    (
                        button.title().to_string(),
                        button.keyEquivalent().to_string(),
                    )
                })
                .collect(),
        )
    })
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
                "hold" | "mock-hold" => {}
                "panic" => break true,
                "real" => break false,
                mode => return Some(mode == "allow" || mode == "mock-allow"),
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
            prepare_alert(&alert, &message);
            #[allow(deprecated)]
            NSApplication::sharedApplication(mtm).activateIgnoringOtherApps(true);
            alert.runModal() == NSAlertFirstButtonReturn
        }))
        .ok()
    })
}

pub(super) fn ask_owner(bundle_id: &str, requirement: &str, class: &str) -> &'static str {
    let key = requirement.to_owned();
    {
        let mut asks = ASKS.lock().unwrap();
        let (pending, declined) = &mut *asks;
        if declined
            .get(&key)
            .is_some_and(|at| at.elapsed() < DECLINE_COOLDOWN)
        {
            return "owner_declined";
        }
        if pending.insert(key.clone()) {
            let (bundle_id, requirement, class, key) = (
                bundle_id.to_owned(),
                requirement.to_owned(),
                class.to_owned(),
                key.clone(),
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
                ANSWERED.notify_all();
            });
        }
    }
    let asks = ASKS.lock().unwrap();
    let (asks, _) = ANSWERED
        .wait_timeout_while(asks, OWNER_WAIT, |asks| asks.0.contains(&key))
        .unwrap();
    if asks.0.contains(&key) {
        return "waiting_for_owner";
    }
    if asks
        .1
        .get(&key)
        .is_some_and(|at| at.elapsed() < DECLINE_COOLDOWN)
    {
        return "owner_declined";
    }
    drop(asks);
    if check(bundle_id, requirement, class).is_ok() {
        "allowed"
    } else {
        "guards_unavailable"
    }
}

#[cfg(test)]
mod approval_tests {
    use super::*;

    #[test]
    fn declined_owner_answer_is_returned_to_the_waiting_caller() {
        FIXTURE_DIALOG.lock().unwrap().0 = "deny";
        let result = ask_owner("io.example.test", "fixture-requirement", "pointer");
        assert_eq!(result, "owner_declined");
    }
}
