# Diagnose approved PRs whose CI observation is stale

Read shared setup in `../SKILL.md`; no provider, model mock or GUI is needed.
Run the metadata-only helper in a fresh synthetic run through the shared wrapper:

```bash
bash .claude/skills/verify/proof-run.sh /absolute/fresh/evidence-directory \
  .claude/skills/verify/coding-pending-diagnostics.ts
```

The helper owns an ephemeral daemon, live synthetic Neo/worker sessions, refusing
GitHub/Claude executables and a fresh DB. A scripted ledger reader observes an
exact-head approval with CI pending, then a quota failure with a known reset.
It invokes the actual coding-pack sweep and captures public `neo.snapshot`, the
ledger, persisted health and real mailbox payloads. No direct external HTTP,
credentials, live daemon, real DB/copy, port 8399 or model turn is used.

At 15 minutes without a successful PR observation, the existing health-notice
path must accept exactly one keyed stale-pending wake for Neo. The pending row
shows readAt, completeAt, nextRetryAt, lastError and lastErrorAt. Raw error text
must not appear: lastError is a safe classification, including shared quota
cooldown when an earlier repository stops the sweep. The notice saves the same
structured diagnostics keyed to the PR/head/read so recovery cannot overwrite
the incident context. Normal fresh pending checks do not trigger this notice.

Reopen the app on its own synthetic DB during cooldown: no acquisition and no
duplicate wake. After reset, a green observation sends exactly one approved-green
event to the existing worker and persists told_at. Further sweeps add nothing;
health clears nextRetryAt but retains the historical last error and its time.

Inspect `pending-diagnostics.json`: verified and resourcesStopped must be true,
with beforeRestart/afterRestart facts and the two distinct mailbox jobs. The
baseline fails because pending rows omit the diagnostics and no stalled-pending
notice reaches Neo. The shared wrapper saves evidence and immediately removes
all owned temporary daemon data after the helper closes resources in finally.

Focused tests include neo-coding-pr-events, neo-coding-ledger-source and the
ledger health state/wire/delivery suites. The quota-reset control proves an
empty repository ordered first does not itself prevent later green delivery
once acquisition resumes. This is not proof of the historical incident's cause,
live quota behavior, desktop-model consumption or an indefinite-backoff fix.
