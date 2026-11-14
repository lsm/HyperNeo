# Desktop status read

`desktop.status` reports a desktop-control worker's state from the existing
records, and reads `stopped` after `desktop.stop`.

```bash
TMPDIR=/private/tmp bash .claude/skills/verify/desktop-status.sh /absolute/evidence/dir
```

The helper launches an isolated daemon, creates one session, seeds a doing,
approved todo with `named.desktopControl` bound to it (`desktop-takeover-seed.ts`),
starts a `sleep` process as the stand-in driver with its real process identity,
and listens on `data/desktop/control.sock` as a stand-in HyperNeo Desktop.

Pass means the script prints `desktop status journey: PASS`:

- `status-before.json` and `status-list.json` read `running` with the todo title;
- `stop.json` reads `stopped`, `status-after.json` reads `stopped`;
- `driver.txt` reports the stand-in exited with 143 (SIGTERM);
- `worker-dir.txt` lists the `stopped` latch.

Not covered: a real Cua driver and the real HyperNeo Desktop control channel.
