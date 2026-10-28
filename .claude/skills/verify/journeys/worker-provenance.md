# Observed worker provenance at delivery

Read shared SKILL.md. Run from the worktree root:

```bash
bash .claude/skills/verify/proof-run.sh /absolute/fresh/evidence-directory .claude/skills/verify/worker-provenance.ts 0
```

This metadata-only helper owns a fresh daemon on an ephemeral non-8399 port,
synthetic Claude CLI and Desktop registrations, bootstrap transcripts and private
inbox sockets. No real provider, credentials, desktop process or live DB is used.
The synthetic CLI records Opus 5.5/medium in the bootstrap assistant envelope.

Public WebSocket work.start must deliver that observed Agent line in the first
task input after import, matched to its native inbox receipt. Then the real todo
runner for a core.evidence file-check task calls public work.status and work.send:
stale row values are replaced with Opus 5.5/medium, then Sonnet 5/high, then Sonnet
5/unknown. The actual native transcript input and stored todo identity must agree.
Same-ref bind preserves identity; replacement clears it. observed.json retains
RPC replies, native frames and delivered text; run-status.json confirms cleanup.

Native UI rendering, real provider turns, remote daemon forwarding and real
Codex/Copilot clients are unverified. Unit adapter tests cover the other first-input
boundaries and HyperNeo effort without request.effort.

The same helper also enters the real daemon's production MCP operation registry:
neo.ask.open and neo.todo.add with bind targets must immediately store observed
identity. neo.todo.bind to a second synthetic Claude worker must re-read that
worker's Sonnet/high identity. This exercises production todoControls wiring,
not just a runner supplied by a test harness. Failed/malformed status responses
preserve the last observed pair; a successful status with absent fields still
records explicit unknown (unit regression coverage).

Each provenance brief leads with a fresh delivery UUID within the first 80
characters. The native-inbox proof checks that stored openings appear in their
actual inputs and differ across follow-ups. Unit regressions use receiptless
sends to a shared worker: another todo's input cannot land the lost send or
supply its reply, even with identical task text and observed identity. Repeated
identical follow-ups on the same todo also get distinct openings.
