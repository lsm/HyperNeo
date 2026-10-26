# Queued Codex worker turns retain their sandbox network policy

Use the shared isolation and resource guards in `../SKILL.md`. Supply the absolute
path to the installed Desktop-bundled Codex executable, not an older standalone CLI:

```sh
bash .claude/skills/verify/proof-run.sh /absolute/fresh/evidence-directory \
  .claude/skills/verify/codex-queued-loopback.ts /absolute/codex-executable
```

The proof starts a real isolated app-server, a scripted loopback Responses model
and a prepared worker. It sets the initial worker policy, then uses the real
thread settings API to reproduce restricted Desktop defaults. Production
`queueCodexMessage` queues the next input; the real queue consumer starts a turn
whose shell starts and connects to an HTTP server on 127.0.0.1. Outside writes
must still fail. The fixture simulates the Desktop settings change through its
supported API; native Desktop UI is not driven. No real model, credentials,
live daemon or port 8399 is used.

Before the fix, `queued-loopback.json` lacks a successful local-server receipt
and model requests retain the real binding denial. Afterward the calls show
`thread/settings/update` before `thread/queue/add`, `localServer.connected` is
true and `outsideRefused` remains true. The helper stops both processes and
releases worker runtime roots; the wrapper retains evidence and removes its data.
