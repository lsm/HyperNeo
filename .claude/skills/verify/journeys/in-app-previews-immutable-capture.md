# Immutable Git byte storage after local capture retirement

Use the daemon Vitest runner for preview-capture.test.ts. Its native helper
accepts byte buffers, matching the only production caller in git-capture.ts.
C4 removed the unused hashSource and path/segments capture overload, not the
shared descriptor backend used by current reads or stored-blob verification.

From the worktree root, use the shared resource check and isolated wrapper:

```sh
TMPDIR=/private/tmp bash .claude/skills/verify/proof-run.sh /absolute/new/evidence .claude/skills/verify/preview-capture.ts
```

Require exit 0 and evidence/capture-evidence.json (copied to the persistent
wrapper evidence directory). The proof checks exact binary/Unicode bytes and
SHA-256, empty input, read-only blobs, serial/concurrent dedup, size/quota gates,
caller-buffer mutation isolation, directory-sync/disk-full faults and crash
recovery. An owned child deliberately syncs only 256 KiB then is killed; restart
must retain and charge those partial bytes, plus existing complete blobs.

Interrupted links remain intact and three repeated identical byte captures must
not add retained bytes. Corrupt existing blobs or excessive links fail closed.
The stored-descriptor verifier still checks size, identity, timestamps, link
count and full hash. A live source's mutation/path/symlink checks belong to the
unchanged live-reader/descriptor journeys, not this byte-only writer.

Only success removes its own staging file after durable linking. Failures retain
staging and release reservations; inventory counts shared inodes once. No stored
data is swept or deleted. Native directory-sync refusal must never fall back to
an unsafe write. This proves process interruption, not every host power-loss case.

Run retained Git capture/resolve and Git row/identity proofs through the real
isolated daemon, then existing live-reader and legacy-reader controls. Keep
synthetic HOME/data, no credentials/provider, free ports and cleanup from SKILL.md.
