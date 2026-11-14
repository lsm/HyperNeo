# Desktop status and Stop / take over

A worker whose todo turned on desktop control shows its desktop state in the
Neo drawer and in its session view, and the human can stop its driver there.

Run from the worktree root with a fresh web build:

```bash
cd packages/web && bun run build && cd ../..
NODE_PATH=<directory containing playwright> TMPDIR=/private/tmp \
  bash .claude/skills/verify/desktop-takeover.sh /absolute/evidence/dir
```

The helper launches an isolated daemon, creates one session, seeds a doing,
approved todo with `named.desktopControl` bound to it (`desktop-takeover-seed.ts`),
starts a `sleep` process as the stand-in driver with its real process identity,
and listens on `data/desktop/control.sock` as a stand-in HyperNeo Desktop.

Pass means:

- `status-before.json` reads `running` and `status-after.json` reads `stopped`;
- `web-observations.json` shows the drawer with one Stop button while running,
  its todo title opening the worker's session in Neo, then the session view
  with no button after the stop;
- `driver.txt` reports the stand-in exited with 143 (SIGTERM from `desktop.stop`);
- `worker-dir.txt` lists the `stopped` latch;
- screenshots `drawer-running.png`, `drawer-opened-session.png`, `session-running.png`,
  `session-running-dark.png` and `session-stopped.png`.

Not covered: a real Cua driver and the real HyperNeo Desktop control channel.
