# Desktop permissions when needed

Use a release bundle: debug builds resolve the permission page against the
development server, which does not serve the bundled setup assets. The setup
window is disabled in debug builds until those assets are available there.

On a macOS test host with a display, build a fresh desktop bundle from this
checkout after the resource check. Use Bun 1.4.4 and run one build at a time.
Start the bundle with `NODE_ENV=test`, a fresh HOME, data directory and DB, and
no provider keys. Confirm port 9283 is free first. Do not attach to a human's
running daemon. The release asset check can run without a display:

```bash
cargo test --release --manifest-path packages/desktop/src-tauri/Cargo.toml \
  --lib --features tauri/custom-protocol \
  permissions_page::tests::release_bundle_contains_the_permissions_page_at_its_window_url
cargo test --release --manifest-path packages/desktop/src-tauri/Cargo.toml \
  --lib --features tauri/custom-protocol \
  desktop_permissions::tests::settings_opener_is_reaped_after_exit
```

It checks the embedded page and script at the window URL and rejects the extra
`loading/` prefix. The second test checks that the settings opener is reaped.
These checks do not prove that a webview renders.

On a test account with either permission absent, confirm no desktop permissions
window appears at startup. Approve a todo with desktop control and invoke
`desktop.call` as its worker; confirm the permissions window appears and the
call is refused without dispatch. While the guide is visible, switch to another
app and repeat the call; confirm the guide does not steal focus. The Accessibility
and Screen Recording buttons must request access and open their respective System Settings panes. After
granting Screen Recording, quit and reopen the app to finish the grant.

With both permissions granted, retry `desktop.call` as the opted-in worker
against a test-owned app, allowing the requested app access in the owner dialog.
Use `get_window_state` for the test app and confirm the reply reports `ok: true`,
`decision: allowed`, and `dispatched: true`, with the expected window state.
Confirm the permissions window does not reopen and capture screenshots for
review. Do not change permission settings on another person's account to create
these states.

Close the owned app and stop its owned sidecar. Report missing display access,
permission states, successful dispatch or screenshots as unverified; a successful
build is not UI proof. The web component test exercises the buttons and status
update without opening System Settings.
