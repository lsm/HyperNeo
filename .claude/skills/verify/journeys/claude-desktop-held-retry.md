# Claude Desktop stale-mode hold and one retry

Read shared `SKILL.md`. Run both cases with separate evidence directories:

```bash
TMPDIR=/private/tmp bash .claude/skills/verify/proof-run.sh "$EVIDENCE/local" \
  .claude/skills/verify/claude-held-retry.ts 0
TMPDIR=/private/tmp bash .claude/skills/verify/proof-run.sh "$EVIDENCE/remote" \
  .claude/skills/verify/claude-held-retry.ts remote 0
```

The helper owns a real isolated daemon, RPC client, Unix peer and fake `claude`
and `ps` executables. No model, real credentials, Desktop state or GUI is used.
Allow about one minute for the production transcript confirmation windows.

Observe `observed.json` and `native-events.jsonl`:

- Desktop metadata stays auto while the verified receiver PID's synthetic launch
  command says bypassPermissions. The initial prompting-side frame is held and
  emits a real protocol held receipt plus a synthetic transcript notice.
- With no accepted input in the bounded confirmation window, the daemon reads
  the live receiver mode and launches exactly one bypass-side relay. Its receipt
  identifies the single accepted marker; a held transport fact is not delivery.
- The remote-origin case invokes the same RPC the receiver sees from a forwarded
  send. The sender has no reverse attachment. Both the Desktop record and the
  process launch arguments still say auto after an interactive turn in
  bypassPermissions. The relay uses that turn's mode, ignores a newer sidechain
  entry, and writes exactly one accepted input to the target transcript.
- A second send whose relay also refuses returns not_delivered with the receiver
  mode and relay error. Both cases make one relay per call.
- The metadata remains byte-identical. All resources close in finally; retain
  the evidence outside the run directory before removing the run.

This proves the daemon's RPC/transport and retry decisions with synthetic live
process args, not the installed Desktop's GUI or live governor behavior. The
existing [delivery journey](claude-desktop-b1.md) covers unchanged direct routes,
metadata fallback when launch args are unavailable, and stopped-session sends.
