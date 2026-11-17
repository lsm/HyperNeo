# Turn desktop control on for one todo

Desktop control is off for every todo until the human turns it on for one.
The todo's ⋯ menu on the Neo page holds the switch; once on, the row shows a lit
computer icon, and the daemon reads it as that worker's opt-in.

Run from the worktree root with a fresh web build:

```bash
cd packages/web && bun run build && cd ../..
NODE_PATH=<directory containing playwright> TMPDIR=/private/tmp \
  bash .claude/skills/verify/desktop-control-toggle.sh /absolute/evidence/dir
```

The helper launches an isolated daemon and seeds one open ask with two doing,
approved todos, each bound to its own worker (`desktop-control-toggle-seed.ts`).
No HyperNeo Desktop or driver runs.

Pass means:

- `status-before.json` lists both workers as `off`;
- `web-observations.json` shows no lit computer on the dentist row, then one
  after turning it on from the menu and reloading, and none on the taxes row;
- `status-after.json` reads `unavailable` for the dentist worker (opted in, no
  Desktop running) and `off` for the taxes worker;
- `named.txt` shows `{"desktopControl":true}` on the dentist todo only;
- screenshots `todo-off.png`, `todo-on.png` and `todo-on-dark.png`.

Not covered: a running HyperNeo Desktop or driver.
