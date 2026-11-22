use std::path::{Path, PathBuf};
use std::process::Command;

const PLUGIN: &str = "/Library/Security/SecurityAgentPlugins/HyperNeoLockedUse.bundle";
const SIGNER: &str = "anchor apple generic and certificate leaf[subject.OU] = \"P5R65T296V\"";
const SCRIPT: &[&str] = &[
    "on run argv",
    "set {appPath, installerPath, pluginPath, signerRequirement} to argv",
    "try",
    "set output to do shell script \"/usr/bin/codesign --verify --strict --deep --test-requirement \" & quoted form of (\"=\" & signerRequirement) & \" \" & quoted form of appPath & \" && /bin/bash \" & quoted form of installerPath & \" \" & quoted form of pluginPath with prompt \"HyperNeo wants to change who can unlock this Mac.\" with administrator privileges",
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
        "Install Locked Use…"
    }
}

pub(crate) fn app_bundle() -> Option<PathBuf> {
    let app = std::env::current_exe().ok()?.parent()?.parent()?.parent()?.to_path_buf();
    shipped(&app).then_some(app)
}

fn shipped(app: &Path) -> bool {
    app.join("Contents/Resources/locked-use/install.sh").is_file()
}

fn admin_command(app: &Path, install: bool) -> Command {
    let scripts = app.join("Contents/Resources/locked-use");
    let mut command = Command::new("/usr/bin/osascript");
    for line in SCRIPT {
        command.args(["-e", line]);
    }
    command
        .arg(app)
        .arg(scripts.join(if install { "install.sh" } else { "uninstall.sh" }))
        .arg(scripts.join("HyperNeoLockedUse.bundle"))
        .arg(SIGNER);
    command
}

/// Installs or removes Locked Use behind the macOS admin prompt; true when it is installed after.
pub(crate) fn toggle(app: &Path) -> bool {
    let install = !installed();
    if let Err(error) = admin_command(app, install).status() {
        log::error!("Could not run the Locked Use installer: {error}");
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
    fn locked_use_install_passes_paths_and_scripts_as_arguments_not_script_text() {
        let app = Path::new("/Applications/Hyper \"Neo\" $(x).app");
        let command = admin_command(app, true);
        assert_eq!(command.get_program(), "/usr/bin/osascript");
        assert_eq!(
            payload(&command),
            [
                BODY.to_owned(),
                app.display().to_string(),
                format!(
                    "{}/Contents/Resources/locked-use/HyperNeoLockedUse.bundle",
                    app.display()
                ),
                SIGNER.to_owned(),
                "install".to_owned(),
                include_str!("../../locked-use/install.sh").to_owned(),
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
        let verify = BODY.find("/usr/bin/codesign --verify --strict --deep").unwrap();
        let copy = BODY.find("/usr/bin/mktemp -d /private/tmp/").unwrap();
        let run = BODY.find("/bin/bash \"$d/$4.sh\" \"$2\"").unwrap();
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
            .arg("plugin")
            .arg(SIGNER)
            .arg("install")
            .arg(format!("touch '{}'", marker.display()))
            .args(["", "", ""])
            .status()
            .unwrap();
        assert!(!status.success());
        assert!(!marker.exists());
    }

    #[test]
    fn locked_use_removal_runs_the_uninstaller() {
        assert_eq!(
            payload(&admin_command(Path::new("/A.app"), false))[4],
            "uninstall"
        );
    }

    #[test]
    fn locked_use_menu_needs_a_valid_signature_not_just_the_installer() {
        let dir = tempfile::tempdir().unwrap();
        assert!(!available(dir.path()));
        let scripts = dir.path().join("Contents/Resources/locked-use");
        std::fs::create_dir_all(&scripts).unwrap();
        std::fs::write(scripts.join("install.sh"), "").unwrap();
        assert!(!available(dir.path()));
        assert_eq!(label(false), "Install Locked Use…");
        assert_eq!(label(true), "Remove Locked Use…");
    }
}
