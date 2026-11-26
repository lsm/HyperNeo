# Paired attachment upload

Run this journey on the candidate tree using Bun 1.4.4 and the shared
isolation and cleanup in SKILL.md. The daemon online CI suite runs the same
helper in `attachment-upload.test.ts`.

```sh
TMPDIR=/tmp bash .claude/skills/verify/proof-run.sh "$EVIDENCE" \
  .claude/skills/verify/attachment-upload.ts "$(git rev-parse HEAD)"
```

The helper pairs a synthetic device over HTTP and drives the real daemon PUT
route. Check the receipt for anonymous and cross-site refusals, a hash and
signature mismatch, and a 413 from a chunked upload before the client finishes
the body. A duplicate PUT refreshes the existing file, and two concurrent PUTs
succeed with one lowercase file containing the original bytes. Startup removes
an expired image and abandoned temporary file while retaining a recent image.
Rejected writes leave no temporary files. Require wrapper exit zero and retain
`attachment-upload.json` and `run-status.json`.
