# Coding GitHub Issues adapter

Run with Bun 1.4.2 from the repository root.

```sh
TMPDIR=/private/tmp bash .claude/skills/verify/proof-run.sh /absolute/fresh/evidence-directory .claude/skills/verify/coding-issue-tracker.ts
```

The isolated daemon uses its own HOME and DB, ephemeral ports, no provider, and a
synthetic gh API. The coding pack starts disabled for mirroring. Repository
preferences enable a cross-repository plan, which recovers after a crash between
issue creation and binding, links children, adds a late step, and closes items.

A real gh subprocess hangs before a late create. The adapter must kill it at the
30-second deadline, record one failure, and create one item on a later sweep.
Retain observed.json and the daemon logs. The wrapper removes temporary data.
Real GitHub cross-repository sub-issue behavior remains a separate verification.
