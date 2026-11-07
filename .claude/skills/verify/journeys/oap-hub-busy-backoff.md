# OAP hub busy backoff

Use the shared isolation, resource guard and pinned Bun in `../SKILL.md`.

```sh
TMPDIR=/private/tmp bash .claude/skills/verify/proof-run.sh /absolute/fresh/evidence-directory .claude/skills/verify/oap-hub-busy-backoff.ts
```

The helper starts an isolated daemon on an ephemeral port and an owned synthetic
stdio hub child with scrubbed credentials. An authenticated RPC message submits
through the production query adapter and hub client. The child refuses the first
submit as busy, measures the replay interval, then emits a completed reply. The
proof requires exactly two submit attempts, at least 45 ms between attempts and
the visible result persisted in the session. Cleanup closes the socket, daemon
and child before removing temporary data. Provider routing and a real OAP binary
remain outside this synthetic journey.
