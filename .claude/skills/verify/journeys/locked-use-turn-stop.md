# Stop a native worker's Desktop turn

Run the daemon half in [Desktop actions](desktop-call.md). Run the Desktop half
on a macOS build host with the isolated control socket and fake guardian and
driver. The host fixture sends no GUI input and uses no screen- or lock-state
access.

```bash
cargo rustc --locked --manifest-path packages/desktop/tests/driver-host/Cargo.toml \
  --bin desktop-driver-fixture -- --cfg test
python3 packages/desktop/tests/worker-drivers.py \
  packages/desktop/tests/driver-host/target/debug/desktop-driver-fixture -k test_turn_stop
```

Expect three passing cases. A stop during Locked Use startup closes the
guardian and refuses the call. A stop during ownership waits for the guardian
to exit and refuses stale calls. A queued call is refused before the slot frees,
and a driver that finishes starting later receives no call from that turn. A
later turn in the same worker session reaches the driver. An action the driver
already received may finish.

Before merging, run the worker stop portion of the
[attended signed Desktop checks](locked-use-plugin.md). Start another turn in
the same session after the guardian exits. Verify that the later turn can use
Calculator and that stopping it releases Locked Use again.
