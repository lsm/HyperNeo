# Reset completes when the SDK never answers interrupt

Use the shared isolated metadata-only setup and cleanup in SKILL.md:

```sh
bash .claude/skills/verify/proof-run.sh /absolute/fresh/evidence-directory .claude/skills/verify/session-stop-interrupt.ts
```

This listener-free helper calls the real AgentSession.resetQuery method used by
session.resetQuery, backed by a migrated disposable database. It tracks a real
owned child process and injects an SDK interrupt response that never settles.
Reset must finish within its existing termination budgets, terminate that child,
clear the old query, and leave the session idle. It needs no provider, model,
HTTP mock, browser, socket, or external network.

On the baseline, reset remains pending until the proof deadline: the interrupt
is reached but force termination and query close are never reached. The finally
block releases the synthetic interrupt, kills only the owned child, and closes
the session/database. Preserve observed.json and proof.log; the shared wrapper
removes synthetic data after saving evidence.

This proves the native reset and process-lifetime surface. It does not establish
HTTP/WebSocket transport, web rendering, provider behavior, or Neo wake delivery.
The all-error start/run failure budget and its terminal wake belong to #9093.
