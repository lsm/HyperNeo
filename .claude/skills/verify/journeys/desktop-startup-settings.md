# Desktop startup settings

On a macOS build host, build the desktop app from the candidate tree. Use a
fresh temporary HOME, a separate absolute data directory and workspace, and an
unused non-default loopback port. Do not pass provider credentials. Write the
desktop settings file described in the desktop README with those values.

Launch the built app from the isolated environment with no daemon running.
Verify the sidecar advertises the configured port in the configured data
directory and the app opens that daemon. Stop the app and its owned sidecar.
Start an isolated daemon with the same settings, relaunch the app, and verify
it attaches to that daemon rather than starting another. Confirm the configured
workspace and a harmless extra daemon environment marker in the spawned process.
Record the observed URL, process identities and exit codes without credentials.
Stop only owned processes and remove the temporary data after retaining evidence.

Also launch with malformed settings in the isolated HOME. Verify the startup
window reports the settings error and no sidecar starts. An empty port override
must use the configured port.

The Rust startup settings test checks the descriptor path and spawned arguments;
it does not replace this bundled-app journey or verify the first-run permissions UI.
