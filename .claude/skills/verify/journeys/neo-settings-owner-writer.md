# Neo-owned settings use the shared writer

Use the shared guarded proof wrapper; this journey needs no provider, model turn,
HTTP mock, real credentials or GUI. It owns an ephemeral WebSocket daemon.

```bash
bash .claude/skills/verify/proof-run.sh /absolute/fresh/evidence-directory .claude/skills/verify/neo-settings-writer.ts verify
```

The real `neo.session.mute`, `neo.rule.save` and `neo.preferences.set` RPC doors
must preserve a competing settings commit. The helper commits a UI edit on a
second synthetic WAL connection immediately before the legacy INSERT or before
the replacement writer command is queued. This deterministic scheduling exposes
the old stale whole-Neo replacement. Run `before` on the baseline to retain all
three losses; `verify` must fail on that baseline.

The fixed run must also retain both simultaneous mute/rule edits alongside a
`settings.global.update`, refuse a missing-rule removal without writing, expose
the rules/preferences in `neo.snapshot`, and publish committed `state.settings`.
No target settings write may reach the daemon main connection. A 1.2-second held
writer lock must leave health and the event loop responsive; that affected write
still misses the 250 ms target and is recorded explicitly.

Evidence is `neo-settings-writer.json`. The helper closes its owned socket,
daemon, lock process and WAL connection in finally; the wrapper saves evidence
before deleting disposable data. This proves RPC persistence and notification,
not GUI rendering, real provider alignment, or queue/SQL/clone timing.
The same helper runs under Deno 2.9.4 in `scripts/deno-smoke.sh`; run that smoke
after the shared resource guard, as a separate heavy job. Its JSON summary in
the smoke log is saved before temporary data is deleted. Paired baseline/Bun
results and the Deno summary live in `evidence/neo-settings-owner-writer/`.
