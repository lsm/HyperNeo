use security_framework::passwords::{generic_password, PasswordOptions};

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

#[cfg(test)]
pub(super) fn record(
    bundle_id: &str,
    requirement: &str,
    class: &str,
    keep: bool,
) -> Result<(), String> {
    use security_framework::{
        access_control::{ProtectionMode, SecAccessControl},
        passwords::{delete_generic_password_options, set_generic_password_options},
    };
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
