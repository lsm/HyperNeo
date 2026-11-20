use objc2_app_kit::{
    NSAlert, NSAlertFirstButtonReturn, NSAlertSecondButtonReturn, NSApplication, NSWorkspace,
};
use objc2_foundation::{NSBundle, NSString};
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

const WILDCARD: &str = "*";

fn allows_wildcard(bundle_id: &str) -> bool {
    let id = bundle_id.to_ascii_lowercase();
    !matches!(
        id.as_str(),
        "io.hyperneo.app"
            | "com.apple.terminal"
            | "com.apple.keychainaccess"
            | "com.apple.systempreferences"
            | "com.apple.systemsettings"
            | "com.apple.passwords"
            | "com.googlecode.iterm2"
            | "net.sourceforge.iterm"
            | "com.mitchellh.ghostty"
            | "net.kovidgoyal.kitty"
            | "com.github.wez.wezterm"
            | "org.alacritty"
            | "io.alacritty"
            | "co.zeit.hyper"
            | "org.tabby"
            | "com.termius.mac"
            | "com.rioterm.rioterm"
            | "dev.waveterm.waveterm"
            | "com.bitwarden.desktop"
            | "org.keepassxc.keepassxc"
            | "com.lastpass.lastpass"
    ) && !["dev.warp.", "com.1password.", "com.agilebits."]
        .iter()
        .any(|prefix| id.starts_with(prefix))
}

fn options(account: &str) -> PasswordOptions {
    let mut options = PasswordOptions::new_generic_password(SERVICE, account);
    options.use_protected_keychain();
    options.set_access_group(GROUP);
    options.set_access_synchronized(Some(false));
    options
}

fn has_grant(account: &str, value: &str) -> Result<bool, &'static str> {
    #[cfg(test)]
    if let Some(stored) = FIXTURE_GRANTS.lock().unwrap().get(account) {
        return Ok(stored == value);
    }
    #[cfg(test)]
    if FIXTURE_DIALOG.lock().unwrap().0.starts_with("mock-") {
        return Ok(false);
    }
    match generic_password(options(account)) {
        Ok(stored) => Ok(stored == value.as_bytes()),
        Err(error) if error.code() == NOT_FOUND => Ok(false),
        Err(_) => Err("guards_unavailable"),
    }
}

pub(super) fn check(bundle_id: &str, requirement: &str, _class: &str) -> Result<(), &'static str> {
    if bundle_id.eq_ignore_ascii_case("io.hyperneo.app") {
        return Err("app_not_grantable");
    }
    if has_grant(&format!("all\n{requirement}"), bundle_id)?
        || (allows_wildcard(bundle_id) && has_grant(WILDCARD, WILDCARD)?)
    {
        Ok(())
    } else {
        Err("app_action_not_authorized")
    }
}

fn write_grant(account: &str, value: &str, keep: bool) -> Result<(), String> {
    #[cfg(test)]
    if FIXTURE_DIALOG.lock().unwrap().0.starts_with("mock-") {
        let mut grants = FIXTURE_GRANTS.lock().unwrap();
        if keep {
            grants.insert(account.to_owned(), value.to_owned());
        } else {
            grants.remove(account);
        }
        return Ok(());
    }
    #[cfg(test)]
    if !keep {
        FIXTURE_GRANTS.lock().unwrap().remove(account);
    }
    let mut options = options(account);
    let result = if keep {
        let device_only = ProtectionMode::AccessibleAfterFirstUnlockThisDeviceOnly;
        options.set_access_control(
            SecAccessControl::create_with_protection(Some(device_only), 0)
                .map_err(|error| format!("grant_store_refused: {}", error.code()))?,
        );
        set_generic_password_options(value.as_bytes(), options)
    } else {
        delete_generic_password_options(options)
    };
    result.map_err(|error| format!("grant_store_refused: {}", error.code()))
}

#[cfg(test)]
pub(super) fn record(
    bundle_id: &str,
    requirement: &str,
    _class: &str,
    keep: bool,
) -> Result<(), String> {
    write_grant(&format!("all\n{requirement}"), bundle_id, keep)
}

fn app_presentation(alert: Option<&NSAlert>, bundle_id: &str, requirement: &str) -> Option<String> {
    let workspace = NSWorkspace::sharedWorkspace();
    let url = workspace.URLForApplicationWithBundleIdentifier(&NSString::from_str(bundle_id))?;
    let path = url.path()?;
    if !super::target::matches_app(&path.to_string(), bundle_id, requirement) {
        return None;
    }
    let bundle = NSBundle::bundleWithURL(&url)?;
    if let Some(alert) = alert {
        let icon = workspace.iconForFile(&path);
        unsafe { alert.setIcon(Some(&icon)) };
    }
    ["CFBundleDisplayName", "CFBundleName"]
        .iter()
        .filter_map(|key| bundle.objectForInfoDictionaryKey(&NSString::from_str(key)))
        .filter_map(|value| value.downcast::<NSString>().ok())
        .map(|name| name.to_string())
        .find(|name| !name.trim().is_empty())
}

fn dialog_text(app_name: &str, class: &str, wildcard: bool) -> Option<String> {
    match class {
        "observe" | "launch" | "pointer" | "keyboard" => (),
        _ => return None,
    }
    let mut text = format!(
        "A HyperNeo worker asked to open this app, see its windows, click, scroll and type in it.\n\nApp: {app_name}\n\nIf you allow it, HyperNeo workers can do these actions in this app without asking again."
    );
    if wildcard {
        text.push_str("\n\nAllow all apps extends this permission to other apps. Sensitive apps such as Terminal, Keychain Access, System Settings and Passwords still ask separately.");
    }
    Some(text)
}

#[cfg(test)]
pub(super) fn admit(bundle_id: &str, requirement: &str, _class: &str) {
    FIXTURE_GRANTS
        .lock()
        .unwrap()
        .insert(format!("all\n{requirement}"), bundle_id.to_owned());
}

fn prepare_alert(alert: &NSAlert, app_name: &str, message: &str, wildcard: bool) {
    alert.setMessageText(&NSString::from_str("Allow HyperNeo to control an app?"));
    alert.setInformativeText(&NSString::from_str(message));
    alert.addButtonWithTitle(&NSString::from_str(&format!("Allow {app_name}")));
    if wildcard {
        alert.addButtonWithTitle(&NSString::from_str("Allow all apps"));
    }
    alert
        .addButtonWithTitle(&NSString::from_str("Don't Allow"))
        .setKeyEquivalent(&NSString::from_str("\u{1b}"));
}

#[cfg(test)]
pub(super) fn dialog_buttons(bundle_id: String) -> Option<Vec<(String, String)>> {
    dispatch2::run_on_main(move |mtm| {
        let alert = NSAlert::new(mtm);
        let name = fixture_app_name(&bundle_id);
        let wildcard = allows_wildcard(&bundle_id);
        let message = dialog_text(&name, "launch", wildcard)?;
        prepare_alert(&alert, &name, &message, wildcard);
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

#[cfg(test)]
pub(super) fn dialog_texts() -> BTreeMap<&'static str, Option<String>> {
    dispatch2::run_on_main(|_| {
        let finder = fixture_app_name("com.apple.finder");
        ["observe", "launch", "pointer", "keyboard", "other"]
            .into_iter()
            .map(|class| (class, dialog_text(&finder, class, true)))
            .collect()
    })
}

#[cfg(test)]
fn fixture_app_name(bundle_id: &str) -> String {
    let resolved = super::target::resolve(
        "launch_app",
        &serde_json::json!({"bundle_id": bundle_id}),
        None,
    );
    resolved["value"]["requirement"]
        .as_str()
        .and_then(|requirement| app_presentation(None, bundle_id, requirement))
        .unwrap_or_else(|| bundle_id.to_owned())
}

enum OwnerAnswer {
    App,
    AllApps,
    Declined,
}

fn owner_allows(bundle_id: &str, requirement: &str, class: &str) -> Option<OwnerAnswer> {
    let wildcard = allows_wildcard(bundle_id);
    #[cfg(test)]
    let fail = {
        FIXTURE_DIALOG.lock().unwrap().1 += 1;
        loop {
            let mode = FIXTURE_DIALOG.lock().unwrap().0;
            match mode {
                "hold" | "mock-hold" => {}
                "panic" => break true,
                "real" => break false,
                "allow" | "mock-allow" => return Some(OwnerAnswer::App),
                "mock-allow-all" if wildcard => return Some(OwnerAnswer::AllApps),
                _ => return Some(OwnerAnswer::Declined),
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
            if check(bundle_id, requirement, class).is_ok() {
                return None;
            }
            let alert = NSAlert::new(mtm);
            let name = app_presentation(Some(&alert), bundle_id, requirement)
                .unwrap_or_else(|| bundle_id.to_owned());
            let message = dialog_text(&name, class, wildcard)?;
            prepare_alert(&alert, &name, &message, wildcard);
            #[allow(deprecated)]
            NSApplication::sharedApplication(mtm).activateIgnoringOtherApps(true);
            let response = alert.runModal();
            Some(if response == NSAlertFirstButtonReturn {
                OwnerAnswer::App
            } else if wildcard && response == NSAlertSecondButtonReturn {
                OwnerAnswer::AllApps
            } else {
                OwnerAnswer::Declined
            })
        }))
        .ok()
        .flatten()
    })
}

pub(super) fn ask_owner(bundle_id: &str, requirement: &str, class: &str) -> &'static str {
    if bundle_id.eq_ignore_ascii_case("io.hyperneo.app") {
        return "app_not_grantable";
    }
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
                let answer = owner_allows(&bundle_id, &requirement, &class);
                let stored = match answer {
                    Some(OwnerAnswer::App) => {
                        write_grant(&format!("all\n{requirement}"), &bundle_id, true)
                    }
                    Some(OwnerAnswer::AllApps) => write_grant(WILDCARD, WILDCARD, true),
                    _ => Ok(()),
                };
                if let Err(error) = stored {
                    log::warn!("Desktop grant was approved but not stored: {error}");
                }
                let mut asks = ASKS.lock().unwrap();
                let (pending, declined) = &mut *asks;
                match answer {
                    Some(OwnerAnswer::App | OwnerAnswer::AllApps) => _ = declined.remove(&key),
                    Some(OwnerAnswer::Declined) => _ = declined.insert(key.clone(), Instant::now()),
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
