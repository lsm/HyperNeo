# Existing Codex turns follow the current worker sandbox preference

Run with a selected installed Desktop-bundled Codex executable and a disposable
HOME through `proof-run.sh`. The helper takes the executable, `desktop` or
`queue`, then the wrapper's run directory:

```sh
TMPDIR=/private/tmp bash .claude/skills/verify/proof-run.sh /absolute/fresh/evidence \
  .claude/skills/verify/codex-existing-turn-sandbox.ts /absolute/codex desktop
```

Repeat with `queue` in a separate fresh run. Each starts a real isolated Codex
app-server and a scripted loopback model. Create the existing thread with a named
network-restricted profile and a marked worker directory, then select the current
`off` preference. The Desktop case uses production ownership discovery and its
no-active-turn fallback over a synthetic Unix IPC peer; that peer forwards the
exact emitted turn request to the native app-server. The queue case uses the
production queue admission and the native queue consumer.

The native shell must bind/connect to a local HTTP server, fetch a synthetic
endpoint, sign a commit through a disposable agent and write to the fixture's
outside directory. Its recorded sandbox policy must be `danger-full-access`.
Before the fix, the Desktop turn retains the old restricted profile and the
queue path reselects its old marked-worker profile. Commit the failing
reproduction before fixing either route. Never use the human's Codex state,
credentials, active threads or live daemon.

The helper closes its native app-server, model and throwaway signing agent;
the wrapper retains JSON/logs and removes its data. The ordinary synthetic-daemon
Codex send journey separately verifies the actual `work.send` RPC routing.
Native Desktop GUI handling of inheritance and deployed worker recovery remain
unverified by the synthetic peer; coordinate those later with Neo.
