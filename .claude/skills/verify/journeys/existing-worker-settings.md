# Work starts with existing local settings

Read shared `../SKILL.md` first. This metadata-only helper needs no provider turn,
HTTP model mock or simulator. Run from the repository root:

```bash
TMPDIR=/private/tmp bash .claude/skills/verify/proof-run.sh \
  /absolute/fresh/evidence-directory \
  .claude/skills/verify/existing-worker-settings.ts
```

The helper owns a real daemon on an ephemeral non-8399 port and synthetic Git
repositories. The source tracks `.claude/settings.local.json` with a permissive
fixture rule. A coding `work.start` must replace the cloned file with the prepared
worker policy and return success. Two further `work.start` calls with `inPlace`
must succeed in that same prepared worktree; both sessions must stay in that
worktree and the sandbox policy must remain intact.

The worker runtime roots live under the run's `HYPERNEO_DATA_DIR` with the
production data-root layout. It uses the shared refusing GitHub stub and a closed
loopback provider endpoint; it does not claim a successful model response, browser
rendering or native OS enforcement. It closes the WebSocket and isolated daemon
in `finally`; the wrapper preserves `observed.json` and `proof.log` then removes
synthetic data and runtime directories. The adapter regression also installs
policy twice in the exact same directory, covering replacement of the existing
native-write marker.
