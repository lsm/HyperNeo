# Coding GitHub Issues adapter

Run with Bun 1.4.2 from the repository root.

```sh
TMPDIR=/private/tmp bash .claude/skills/verify/proof-run.sh /absolute/fresh/evidence-directory .claude/skills/verify/coding-issue-tracker.ts
```

The isolated daemon uses its own HOME and DB, ephemeral ports, no provider, and a
synthetic gh API. The coding pack starts disabled for mirroring. Repository
preferences enable a private cross-repository plan, which recovers after a crash between
issue creation and binding, links children, adds a late step, and closes items.

A real gh subprocess hangs before a late create. The adapter must kill it at the
30-second deadline, record one failure, and create one item on a later sweep.
Retain observed.json and the daemon logs. The wrapper removes temporary data.
Real GitHub cross-repository sub-issue behavior remains a separate verification.

A public repository fixture refuses issue creation and reaches the existing
three-failure cap while its external issue count stays fixed.

The start gate is exercised through the runner with synthetic worker dispatch.
An enabled unbound mirror blocks explicit and queued starts with zero sends.
Binding releases the queue. A capped missing mirror releases work with a card
note. Worker dispatch is synthetic; the daemon and tracker subprocesses are real.

An enabled adapter with no home records one failure per sweep in its creating
row. Three failures release the hold without creating an external item.

If an owner settles before a blank-home placeholder gets a home, the sweep
retires that placeholder without contacting the tracker. Recorded-home rows
retain marker recovery for uncertain creates.

A synthetic mailbox failure rejects the missing-item note after the retry cap.
The queued worker send must still proceed.

Before the first sweep, the helper checks the actual coding tracker home selector.
The enabled and home lookups must use two repository statements total and no
distinct-sibling scan. Stored todo repositories and the historical ask fallback
are read together per lookup. Retain tracker-home-reads.json.
