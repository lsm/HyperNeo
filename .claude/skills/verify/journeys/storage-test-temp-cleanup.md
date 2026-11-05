# Storage test temporary directory cleanup

This test-only journey runs the seven remaining system-backup writers with private
TMPDIRs. Each runs once normally and once with an afterEach hook that throws.
The observer checks the exit status, confirms that the selected tests actually ran,
and requires the fixture directory, backups, WAL, SHM and lock files to disappear.
The scoped-message probe selects its passing message-write case; the concurrent-feed
case has an unrelated existing extra-delta assertion failure under bare Bun. The nag
probe selects the claim-key admission case to avoid an unrelated SQLITE_BUSY scan.
The provider-import reset opens a new filename within its owned directory rather
than unlinking a database while its WAL and SHM siblings still exist.

Run from the repository root:

```sh
bash .claude/skills/verify/proof-run.sh /absolute/fresh/evidence-directory \
  .claude/skills/verify/storage-test-temp-cleanup.ts verify
```

No model or HTTP API mock is needed. After the fourteen fixture probes, the helper boots
an isolated metadata-only daemon on an ephemeral port, checks its synthetic DB,
and shuts it down in finally. The wrapper removes its HOME, data and temporary files.
Evidence is tests.log and cleanup.json. The observable outcome is zero new fixtures
or backups after both successful and failed tests. No browser behavior changes.
