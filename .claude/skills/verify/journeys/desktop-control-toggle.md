# Turn desktop control on for one todo

Desktop control is off for every todo until the human turns it on for one.
An expanded todo row on the Neo page shows the switch, and the daemon reads it
as that worker's opt-in.

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
- `web-observations.json` shows the dentist checkbox unchecked, then checked
  after a reload, and the taxes checkbox still unchecked;
- `status-after.json` reads `unavailable` for the dentist worker (opted in, no
  Desktop running) and `off` for the taxes worker;
- `named.txt` shows `{"desktopControl":true}` on the dentist todo only;
- screenshots `todo-off.png`, `todo-on.png` and `todo-on-dark.png`.

Not covered: a running HyperNeo Desktop or driver.
