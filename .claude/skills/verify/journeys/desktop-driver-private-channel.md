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
