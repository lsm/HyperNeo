# Desktop host dispatch and daemon peer lifetime

Run on a macOS build host. Use the Cargo setup from desktop-driver-private-channel
and the fixture driver from packages/desktop/tests/worker-drivers.py. Every run
owns a disposable data directory, socket, work directory and fake driver. The
fixture provides synthetic target/grant facts for dispatch; it sends input only
to the fake driver's inherited stream. The grant store and real driver are
covered by the existing desktop-grant-approval and desktop-driver-private-channel
journeys.

```bash
cargo test --locked --manifest-path packages/desktop/tests/driver-host/Cargo.toml sidecar_authority_ends_before_its_pid_is_reaped
cargo rustc --locked --manifest-path packages/desktop/tests/driver-host/Cargo.toml --bin desktop-driver-fixture -- --cfg test
python3 packages/desktop/tests/worker-drivers.py packages/desktop/tests/driver-host/target/debug/desktop-driver-fixture
```

The socket must reject a same-user substitute process with not_daemon. A changed,
missing or lifetime-invalid runtime advert must be rechecked on the next
connection. The retained-child test waits for exit without reaping, withdraws
its authority, then reaps it.

Dispatch must start a slot using work_dir, send the named tool and arguments,
reuse the same slot for repeated and concurrent calls, and close it on Stop.
Its reply includes app, class, decision, reason and dispatched. A refused target
must produce no call frame, and a stopped worker must stay stopped. Each dispatch
produces one metadata log line. The tests retain no real grants and close their
fixture host and drivers.

Compile the macOS Tauri release path with the inert-sidecar setup already used
by the Desktop runtime paths CI job. This checks the host's retained sidecar
wiring without launching the app or a daemon. Real owner dialogs and real GUI
input are outside this fixture journey.
