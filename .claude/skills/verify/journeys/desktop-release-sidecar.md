# Signed macOS Desktop starts its daemon

Use a Developer ID signed app built from the candidate ref. For a regression
reproduction, use a disposable copy of the affected signed app. Keep the
installed app and its daemon running as they were.

From the repo root, run the following with an app path and a private evidence
directory.

```bash
codesign --verify --deep --strict "$APP"
spctl --assess --type execute --verbose=4 "$APP"
python3 .claude/skills/verify/desktop-release-sidecar.py "$APP" "$EVIDENCE/desktop.log"
```

Record all three exit statuses. A signing-only candidate may fail Gatekeeper
because it has no notarization ticket. Record the result and use the
[macOS disk image journey](release-macos-dmg.md) when a notarized release
candidate is available.

The launch proof uses a fresh home, data directory, workspace and loopback
port. It requires the daemon to be a child of the app, HTTP 200 on that port
and a closed port after cleanup. The failing release reports that its daemon
exited before the UI was ready and running the sidecar directly exits with
SIGKILL. Retain the launch log and proof result outside the disposable run.
