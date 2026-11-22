use std::path::{Path, PathBuf};
use std::process::Command;

const PLUGIN: &str = "/Library/Security/SecurityAgentPlugins/HyperNeoLockedUse.bundle";
const SIGNER: &str = "anchor apple generic and identifier \"io.hyperneo.app\" and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = \"P5R65T296V\"";
const BODY: &str = r#"set -eu
/usr/bin/codesign --verify --strict --deep --test-requirement "=$2" "$1"
d="$(/usr/bin/mktemp -d /private/tmp/hyperneo-locked-use.XXXXXX)"
trap '/bin/rm -rf "$d"' EXIT
printf %s "$3" > "$d/uninstall.sh"
printf %s "$4" > "$d/policy.sh"
printf %s "$5" > "$d/policy.jxa"
/bin/bash "$d/uninstall.sh"
"#;
const SCRIPTS: [&str; 3] = [
    include_str!("../../locked-use/uninstall.sh"),
    include_str!("../../locked-use/policy.sh"),
    include_str!("../../locked-use/policy.jxa"),
];
const SCRIPT: &[&str] = &[
    "on run argv",
    "set command to \"/bin/bash -c \" & quoted form of item 1 of argv & \" locked-use\"",
    "repeat with value in rest of argv",
    "set command to command & \" \" & quoted form of (value as text)",
    "end repeat",
    "try",
    "set output to do shell script command with prompt \"HyperNeo wants to change who can unlock this Mac.\" with administrator privileges",
    "display notification output with title \"Locked Use\"",
    "on error errorText number errorNumber",
    "if errorNumber is not -128 then display alert \"Locked Use\" message errorText",
    "end try",
    "end run",
];

pub(crate) fn installed() -> bool {
    Path::new(PLUGIN).exists()
}

pub(crate) fn label(installed: bool) -> &'static str {
    if installed {
        "Remove Locked Use…"
    } else {
        "Locked Use unavailable"
    }
}

pub(crate) fn app_bundle() -> Option<PathBuf> {
    let app = std::env::current_exe()
        .ok()?
        .parent()?
        .parent()?
        .parent()?
        .to_path_buf();
    available(&app).then_some(app)
}

fn available(app: &Path) -> bool {
    app.join("Contents/Resources/locked-use/HyperNeoLockedUse.bundle")
        .is_dir()
        && Command::new("/usr/bin/codesign")
            .args(["--verify", "--strict", "--test-requirement"])
            .arg(format!("={SIGNER}"))
            .arg(app)
            .status()
            .is_ok_and(|status| status.success())
}

fn admin_command(app: &Path) -> Command {
    let mut command = Command::new("/usr/bin/osascript");
    for line in SCRIPT {
        command.args(["-e", line]);
    }
    command
        .arg(BODY)
        .arg(app)
        .arg(SIGNER)
        .args(SCRIPTS);
    command
}

/// Removes Locked Use behind the macOS admin prompt; true if it remains installed.
pub(crate) fn remove(app: &Path) -> bool {
    if installed() {
        if let Err(error) = admin_command(app).status() {
            log::error!("Could not run the Locked Use uninstaller: {error}");
        }
    }
    installed()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(command: &Command) -> Vec<String> {
        command
            .get_args()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect()
    }

    fn payload(command: &Command) -> Vec<String> {
        args(command)[2 * SCRIPT.len()..].to_vec()
    }

    #[test]
    fn locked_use_removal_passes_paths_and_scripts_as_arguments {
        let app = Path::new("/Applications/Hyper \"Neo\" $(x).app");
        let command = admin_command(app);
        assert_eq!(command.get_program(), "/usr/bin/osascript");
        assert_eq!(
            payload(&command),
            [
                BODY.to_owned(),
                app.display().to_string(),
                SIGNER.to_owned(),
                include_str!("../../locked-use/uninstall.sh").to_owned(),
                include_str!("../../locked-use/policy.sh").to_owned(),
                include_str!("../../locked-use/policy.jxa").to_owned(),
            ]
        );
        assert!(args(&command)[..2 * SCRIPT.len()]
            .iter()
            .all(|arg| !arg.contains("Hyper \"Neo\"")));
    }

    #[test]
    fn locked_use_signer_pins_developer_id_team_and_app_identifier() {
        assert!(SIGNER.contains("anchor apple generic"));
        assert!(SIGNER.contains("identifier \"io.hyperneo.app\""));
        assert!(SIGNER.contains("certificate leaf[field.1.2.840.113635.100.6.1.13] exists"));
        assert!(SIGNER.contains("certificate leaf[subject.OU] = \"P5R65T296V\""));
    }

    #[test]
    fn locked_use_root_step_runs_only_its_own_copies_after_verifying_the_app() {
        let verify = BODY
            .find("/usr/bin/codesign --verify --strict --deep")
            .unwrap();
        let copy = BODY.find("/usr/bin/mktemp -d /private/tmp/").unwrap();
        let run = BODY.find("/bin/bash \"$d/uninstall.sh\"").unwrap();
        assert!(verify < copy && copy < run);
        assert!(!BODY.contains("Resources"));
        assert!(SCRIPT.join("\n").contains("with administrator privileges"));
    }

    #[test]
    fn locked_use_root_step_stops_when_the_app_signature_fails() {
        let dir = tempfile::tempdir().unwrap();
        let marker = dir.path().join("ran");
        let status = Command::new("/bin/bash")
            .args(["-c", BODY, "locked-use"])
            .arg(dir.path())
            .arg(SIGNER)
            .arg(format!("touch '{}'", marker.display()))
            .args(["", ""])
            .status()
            .unwrap();
        assert!(!status.success());
        assert!(!marker.exists());
    }

    #[test]
    fn locked_use_menu_needs_a_valid_signature_not_just_the_installer() {
        let dir = tempfile::tempdir().unwrap();
        assert!(!available(dir.path()));
        let scripts = dir.path().join("Contents/Resources/locked-use");
        std::fs::create_dir_all(&scripts).unwrap();
        std::fs::write(scripts.join("install.sh"), "").unwrap();
        assert!(!available(dir.path()));
        assert_eq!(label(false), "Locked Use unavailable");
        assert_eq!(label(true), "Remove Locked Use…");
    }
}
