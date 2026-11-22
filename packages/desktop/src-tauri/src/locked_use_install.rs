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

    #[test]
    fn locked_use_install_passes_paths_as_arguments_not_script_text() {
        let app = Path::new("/Applications/Hyper \"Neo\" $(x).app");
        let command = admin_command(app, true);
        assert_eq!(command.get_program(), "/usr/bin/osascript");
        let args = args(&command);
        let tail = &args[args.len() - 4..];
        assert_eq!(
            tail,
            [
                app.display().to_string(),
                format!("{}/Contents/Resources/locked-use/install.sh", app.display()),
                format!(
                    "{}/Contents/Resources/locked-use/HyperNeoLockedUse.bundle",
                    app.display()
                ),
                SIGNER.to_owned(),
            ]
        );
        assert!(args[..args.len() - 4]
            .iter()
            .all(|arg| !arg.contains("Hyper \"Neo\"")));
    }

    #[test]
    fn locked_use_install_verifies_the_app_before_running_its_script_as_root() {
        let script = args(&admin_command(Path::new("/A.app"), true)).join("\n");
        let verify = script.find("/usr/bin/codesign --verify --strict --deep").unwrap();
        let run = script.find("/bin/bash").unwrap();
        assert!(verify < run);
        assert!(script.contains("\" && /bin/bash"));
        assert!(script.contains("with administrator privileges"));
    }

    #[test]
    fn locked_use_removal_runs_the_shipped_uninstaller() {
        let args = args(&admin_command(Path::new("/A.app"), false));
        assert_eq!(
            args[args.len() - 3],
            "/A.app/Contents/Resources/locked-use/uninstall.sh"
        );
    }

    #[test]
    fn locked_use_menu_appears_only_in_builds_that_ship_the_installer() {
        let dir = tempfile::tempdir().unwrap();
        assert!(!shipped(dir.path()));
        let scripts = dir.path().join("Contents/Resources/locked-use");
        std::fs::create_dir_all(&scripts).unwrap();
        std::fs::write(scripts.join("install.sh"), "").unwrap();
        assert!(shipped(dir.path()));
        assert_eq!(label(false), "Install Locked Use…");
        assert_eq!(label(true), "Remove Locked Use…");
    }
}
