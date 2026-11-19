# Desktop permissions on startup

Use a release bundle: debug builds resolve the permission page against the
development server, which does not serve the bundled setup assets. The setup
window is disabled in debug builds until those assets are available there.

On a macOS test host with a display, build a fresh desktop bundle from this
checkout after the resource check. Use Bun 1.4.2 and run one build at a time.
Start the bundle with `NODE_ENV=test`, a fresh HOME, data directory and DB, and
no provider keys. Confirm port 9283 is free first. Do not attach to a human's
running daemon.

On a test account with either permission absent, confirm the desktop permissions
window appears at startup. The Accessibility and Screen Recording buttons must
request access and open their respective System Settings panes. After granting
Screen Recording, quit and reopen the app to confirm the grant takes effect. Return to the app and check the
statuses again. With both permissions granted, restart and confirm the window
does not appear. Capture screenshots for review. Do not change permission
settings on another person's account to create these states.

Close the owned app and stop its owned sidecar. Report missing display access,
permission states or screenshots as unverified; a successful build is not UI
proof. The web component test exercises the buttons and status update without
opening System Settings.
