# Claude Desktop stale-mode hold and one retry

Read shared `SKILL.md`. Use a fresh run with synthetic HOME, data and records:

```bash
RUN=$(mktemp -d /private/tmp/hn-held-proof-XXXXXX)
mkdir -p "$RUN/home" "$RUN/bin"
env -i HOME="$RUN/home" PATH="$RUN/bin:$PATH" NODE_ENV=test \
  HYPERNEO_DATA_DIR="$RUN/data" LOG_LEVEL=warn \
  bun .claude/skills/verify/claude-held-retry.ts 19387 "$RUN"
```

The helper owns a real isolated daemon, RPC client, Unix peer and fake `claude`
and `ps` executables. No model, real credentials, Desktop state or GUI is used.
Allow about one minute for the production transcript confirmation windows.

Observe `evidence/observed.json` and `native-events.jsonl`:

- Desktop metadata stays auto while the verified receiver PID's synthetic launch
  command says bypassPermissions. The initial prompting-side frame is held and
  emits a real protocol held receipt plus a synthetic transcript notice.
- With no accepted input in the bounded confirmation window, the daemon reads
  the live receiver mode and launches exactly one bypass-side relay. Its receipt
  identifies the single accepted marker; a held transport fact is not delivery.
- A second send whose relay also refuses returns not_delivered with the receiver
  mode and relay error. It makes one direct attempt and one relay, never a loop.
- The metadata remains byte-identical. All resources close in finally; retain
  the evidence outside the run directory before removing the run.

This proves the daemon's RPC/transport and retry decisions with synthetic live
process args, not the installed Desktop's GUI or live governor behavior. The
existing [delivery journey](claude-desktop-b1.md) covers unchanged direct routes,
metadata fallback when launch args are unavailable, and stopped-session sends.
