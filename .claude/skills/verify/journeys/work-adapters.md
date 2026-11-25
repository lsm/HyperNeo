# Work adapter discovery

Run against each checkout being compared, with a fresh evidence directory:

```bash
TMPDIR=/private/tmp bash .claude/skills/verify/proof-run.sh /absolute/fresh/evidence-directory .claude/skills/verify/work-adapters.ts
```

The helper starts an isolated daemon and invokes `work.adapters` over RPC for
the local catalog and a missing daemon. It records both replies in `replies.json`.
Compare the baseline and changed replies with `diff -u`; both must match and the
wrapper must exit zero. The missing daemon reply must remain a rejection. No
native driver integration or remote daemon is exercised.
