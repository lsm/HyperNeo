# Canonical artifact receipt extraction

Use proof-run.sh with lane-c-artifact-receipt-extract.ts on Bun and cached Deno
(VERIFY_PROOF_RUNTIME=deno). Shared setup owns fresh HOME/data/ephemeral listeners,
scrubs credentials, checks resources, saves evidence and removes temporary data.
No provider turn, GitHub, real native state or live daemon/8399 is used.

Commit the failing helper-availability contracts first while legacy receipt/clock/
rollback characterizations pass. Real artifact.file.register must keep its receipt
and retries; Bun reads the original snapshot bytes. Deno retains its existing
safe_open_unavailable refusal, successful capture/read unverified. Before the
extraction the public behavior already passes, then the helper contract fails.

After extraction compare the public stored JSON byte-for-byte with the canonical
serializer. On both runtimes exercise direct legacy saves in migrated scratch
SQLite across omitted/empty logical IDs, revisions, empty and populated bundles;
compare exact stored strings/key ordering and return reference identity. Preserve
serialization exceptions and caller-owned rollback. Unit tests pin prepare before
serialization before Date.now before statement execution, with no clock/write on
serialization failure. The pure helper performs no SQL/clock/UUID/I/O or mutation.

Measure complete save/helper bodies to <=200 lines; preserve the normalized
JSON.stringify AST, INSERT SQL bytes, clock expression, constructor and receipt
method hashes. Net prepare/run 0 and no baseline increase. Append only this own
Deno smoke line. This remains an extraction characterization: direct legacy scratch saves execute
on their supplied connection. Its historical baseline had one main INSERT for
public Bun registration; current registration activation requires zero main INSERTs
(and Deno retains zero rows). That movement is proved by the separate registration
row journey, not attributed to this pure extraction. Full capture/source/native/OS dependency
closure, pinned Bun when unavailable, browser and Neo deployment remain unverified.
Close scratch DBs, owned sockets/processors/app before wrapper cleanup.
