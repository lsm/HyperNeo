# Desktop driver private channel

Desktop starts each worker's pinned `cua-driver` with one inherited Unix stream
and no pathname endpoint. The guarded driver accepts only a parent signed as
`io.hyperneo.app` by Developer ID team P5R65T296V.

Fake driver, no signing (also runs in CI):

```bash
cargo rustc --locked --manifest-path packages/desktop/tests/driver-host/Cargo.toml \
  --bin desktop-driver-fixture -- --cfg test
python3 packages/desktop/tests/worker-drivers.py \
  packages/desktop/tests/driver-host/target/debug/desktop-driver-fixture
```

The release host build has no test hooks. It must start a driver too, and
return only its state and pid:

```bash
cargo build --locked --manifest-path packages/desktop/tests/driver-host/Cargo.toml
python3 packages/desktop/tests/worker-drivers.py \
  packages/desktop/tests/driver-host/target/debug/desktop-driver-fixture \
  WorkerDrivers.test_release_host_starts_a_driver_only_it_can_reach
```

Real guarded driver, on a Mac with the Developer ID identity in its keychain.
Download the pinned archive named in `packages/desktop/prepare-cua-driver.sh`,
or build it with `packages/desktop/build-cua-driver.sh <dir>`, then:

```bash
APPLE_SIGNING_IDENTITY=<identity name or SHA-1> \
  bash .claude/skills/verify/desktop-driver-channel.sh "$RUN/evidence" <archive.tar.gz>
```

The helper signs a copy of the fixture host as `io.hyperneo.app` and the driver
as `cua-driver`, then starts the driver through Desktop's control socket. Pass
means `desktop-driver-channel.json` shows a started driver, a record with only
`pid` and `startedAt`, `desktop/control.sock` as the only socket, nonzero exits
for a same-user substitute parent and for `serve`, `mcp` and `--version`, and no
driver process after Stop. It grants no macOS permissions and sends no input.


## Host peer lifetime and dispatch recovery

The fixture suite also exercises the host control socket with an attached fake
daemon. Its runtime advert uses the test process birth time so long suites stay
inside the daemon lifetime window. Run the retained-child contract before
building the embedded fixture:

```bash
cargo test --locked --manifest-path packages/desktop/tests/driver-host/Cargo.toml reaped_sidecar_is_not_authorized
```

The fake driver receives all input. A controlled target-birth observation changes
while fake startup is paused, and dispatch must refuse it before sending. Bad
replies and timeouts must retire the channel, preserve dispatched=true after a
complete write, and allow the next call to start a fresh slot. The fixture uses a
short call deadline for the timeout case. A 20 KB request must receive a normal
reply, and an over-limit frame must receive request_too_large. Dispatch logs must
be visible and exclude argument text. No real GUI input is sent.

To verify bundle ID casing, run the native resolver regression and the focused
control-socket dispatch cases against the isolated embedded-host fixture above:

```bash
cargo test --locked --manifest-path packages/desktop/tests/driver-host/Cargo.toml \
  launch_resolves_mixed_case_bundle_id_to_signed_identity
python3 packages/desktop/tests/worker-drivers.py \
  packages/desktop/tests/driver-host/target/debug/desktop-driver-fixture \
  WorkerDrivers.test_dispatch_launch_accepts_case_variants_of_the_approved_app \
  WorkerDrivers.test_resolve_refuses_missing_or_inconsistent_app_identity
```

Launch Services and macOS signature verification resolve the installed Calculator.
The host reports the signed ID, `com.apple.calculator`, and sends it to the fake
driver. The host refuses dispatch when the todo approves a different app.
Inconsistent bundle and signing IDs still produce `target_mismatch`. The fixture
opens no app window.

Compile the macOS release host with the inert-sidecar setup in the Desktop
runtime paths CI job to check retained-child wiring and the release log filter.

## Host restart with a surviving driver

Build the production-admission fixture with the release-host command above,
then run these cases on a macOS runner:

```bash
python3 packages/desktop/tests/worker-drivers.py \
  packages/desktop/tests/driver-host/target/debug/desktop-driver-fixture \
  WorkerDrivers.test_restart_retires_leftover_driver_before_serving_requests \
  WorkerDrivers.test_restart_leaves_reused_driver_pid_alone \
  WorkerDrivers.test_restart_serves_requests_with_an_exited_driver_awaiting_reap
```

The fixture kills its own host and holds the fake driver alive after its private
channel closes. The replacement host must confirm the old driver has exited
before answering status or starting a new driver. A record whose PID now belongs
to a different process must leave that process alive and allow Desktop to start.
An exited driver still awaiting reap must also allow Desktop to serve status.
All three cases use the real control socket and send no GUI input.
