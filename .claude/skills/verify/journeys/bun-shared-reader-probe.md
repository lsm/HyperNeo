# Build Bun parity for the inline shared-reader probes

Use shared resource/isolation/cleanup setup in ../SKILL.md. Run the standalone
Bun probe through the existing wrapper, with pinned Bun 1.4.2 on PATH:

    VERIFY_PROOF_RUNTIME=bun bash .claude/skills/verify/proof-run.sh /absolute/fresh/evidence scripts/bun-shared-reader-probe.ts

This construction preserves the inline turn-range/external-snapshot contract
for turn ranges and external snapshots. It initializes a fresh database through DatabaseCore,
waits for actual startup body copying and drives SDKStatusReader through its
native worker. It starts no listener or model, reads no existing database,
and uses no GitHub, provider credential or live daemon.

Require the pending row's full text, ID and body length and matching count.
Seed a synthetic external Codex database and require the project root, open
folder count and thread ID. Queue a missing-external-file read followed by an
SDK status read: the external read must reject while the queued read completes
with total zero. Do not replace that worker failure with a synchronous mock.

Commit the unavailable-probe regression first. The existing-data refusal must
leave a retained marker unchanged and create no database. Native unit coverage
and the wrapper proof require all result flags, readerClosed/databaseClosed,
and exit zero; retained evidence survives temporary-data cleanup. A PASS flag
before a close error is not success. Inspect the proof log for background
database-close errors.

The schema initializer, body-copy wait and SQLite compatibility layer are existing
dependencies, not new ownership or performance claims. The Bun native entry point now
calls this probe after its 141 legacy cases through proof-run.sh. Require probe
failure to retain its status/evidence and withhold the runner success marker.
