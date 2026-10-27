# Home file references in todo status and next action (#9112)

Use the shared resource guard, isolated metadata-proof wrapper and cleanup rules
in SKILL.md. Reuse installed dependencies; no provider, model, GitHub access,
web build or simulator is needed. Create the evidence parent before running:

```sh
mkdir -p "$EVIDENCE_PARENT"
TMPDIR=/private/tmp bash .claude/skills/verify/proof-run.sh \
  "$EVIDENCE_PARENT/before" \
  .claude/skills/verify/todo-status-file-references.ts rpc all
```

Run before the fix and retain the failed result. It must show an ordinary todo
source resolving successfully while references mentioned only in blockedReason
and nextAction each return accepted:false. A launch or dependency error is not
that reproduction. After the committed fix, repeat into a fresh after directory.

The helper seeds only its own migrated database, native workspace/session binding
and ordinary files inside its synthetic HOME. Each distinct reference appears in
exactly one todo field. It owns an ephemeral non-8399 daemon and calls the same
artifact.reference.resolve operation over WebSocket that clients use for taps.
After the fix, both status-only references must resolve; artifact.file.read must
return their exact unique bytes and retrying the same tap must retain its receipt.
An existing but unmentioned file must still refuse. The normal title-source
control has null status fields and must continue resolving.

The unit regressions run the same cases through the native operation door in
fresh fixtures, one test per missing field. Their helper arguments are native
blockedReason and native nextAction, followed by the fixture directory.

Keep todo-status-file-references.json and the wrapper's run-status.json. Trust
wrapper exit status, including shutdown failures, rather than passed JSON alone.
The JSON records its source head. Commit the failing reproduction before the
source fix; run the successful RPC proof from a committed application head and
keep subsequent changes limited to evidence. The wrapper saves evidence then
immediately removes every temporary daemon directory, including failed runs.

This verifies backend reference resolution and immutable bytes. Native iOS taps,
web layout and model turns are outside this backend journey. The existing
preview-resolve and preview-candidates suites retain broader source-binding and
path-policy coverage.
