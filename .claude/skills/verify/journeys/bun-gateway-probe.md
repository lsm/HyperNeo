# Build Bun parity for inline gateway serialization

Use shared resource/isolation/cleanup setup in ../SKILL.md. With pinned
Bun 1.4.2 on PATH, run:

    VERIFY_PROOF_RUNTIME=bun bash .claude/skills/verify/proof-run.sh /absolute/fresh/evidence scripts/bun-gateway-probe.ts

Two concurrent recordWouldRefuse writes must commit with count two, and an
unregistered read operation must reject. It uses DatabaseCore migrations,
waits for real startup body copying and opens the actual file-backed native
gateway with no inline connection. No listener, provider turn, external HTTP,
GitHub, existing database or live daemon is involved.

Commit the unavailable-probe regression before construction. Unit tests must
observe the real CLI/native worker results, and an existing-data refusal must
leave its marker unchanged without creating a database. Require
startupBodyCopyComplete, serializedWrites, unknownReadRejected, gatewayClosed,
databaseClosed and pass in bun-gateway.json, plus wrapper exit zero.
The unknown-read check must match its registration error, not an unrelated
failure. Close the gateway before the database; let the wrapper retain evidence
and remove synthetic data after the process exits. A result flag before a
cleanup error is not a pass; inspect retained logs for database-close errors.

The Bun native entry point now calls this probe after its 141 legacy cases and the
shared-reader case. This probe's failure must retain status/evidence and withhold the
runner success marker. Existing migration, SQLite and gateway code are reused, not
edited or claimed as a new transitive ownership/performance audit.
