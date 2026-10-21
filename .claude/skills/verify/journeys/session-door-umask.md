# Session door permissions at creation (S10)

From the worktree root, pick a free port other than 8399 and a fresh absolute run
directory, then run:

```bash
bash .claude/skills/verify/session-door-umask.sh 9328 /private/tmp/verify-session-door-s10
```

The helper starts the real CLI daemon under `env -i`, `NODE_ENV=test`, a synthetic
HOME/data directory/DB, and ambient umask 0022. No provider keys, models, browser,
real remotes or live daemon are involved.

A test-only preload observes the HTTP server's listening event **before** it calls
the session door's listen callback and before the later chmod. It records the
actual socket's mode without replacing filesystem or listener behavior. A final
0600 stat alone cannot prove the creation window is closed.

Expected: `creation.json` shows `modeBeforeChmod: 384` (0600) and `umask: 18`
(0022 restored). The real `system.build` request over that Unix socket returns
health `ok`; an operation outside the door allowlist stays refused. `result.json`
retains those observations plus the final 0600 mode. The helper exits nonzero on
any missing observation or mismatch and stops its own daemon on exit.

The focused session-door suite also checks umask restoration when bind fails.
This journey observes the permission boundary, not a login as a second OS user.
Deno execution is a separate check when that runtime is installed.
