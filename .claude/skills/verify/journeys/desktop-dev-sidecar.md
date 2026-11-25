# Desktop dev starts its own daemon

Run the proof from the repo root on a macOS build host with Bun 1.4.4,
Cargo, the Tauri CLI and a GUI session. Install frozen dependencies first.

```bash
bash packages/desktop/tests/dev-sidecar-layout.sh
bash .claude/skills/verify/resource-check.sh
python3 .claude/skills/verify/desktop-dev-sidecar.py "$RUN/desktop"
python3 .claude/skills/verify/desktop-dev-sidecar.py "$RUN/attach-loopback" --attach-loopback
python3 .claude/skills/verify/desktop-dev-sidecar.py "$RUN/attach" --attach
```

The layout check runs the configured Tauri hook with a synthetic Windows
build. It compares the bytes of both debug copies, including the copy in a
custom Cargo target directory with spaces.

The desktop proof runs the actual Tauri dev command with a fresh home,
data directory and loopback port. Expect a spawn log, the app's readiness
log, HTTP 200 from the daemon and a database in the isolated data directory.
Retain `desktop.log` and the exit status as evidence. The loopback attach proof uses a
synthetic local device credential and advertises `127.0.0.1`. The fixture must
receive the matching device cookie in the WebView's HTTP request. It reports
only whether the cookie matched. The alternate-host proof advertises
`localhost` and checks that Tauri logs the pairing fallback. The pairing
page itself requires observing the window separately.
