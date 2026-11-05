# C4: remove unused local capture inputs

Audit the production call graph before editing. capture-owner.ts constructs the
store; git-capture.ts is its only production capture caller and supplies bytes.
hashSource and path/segments capture have no production callers after C3. Remove
only those branches and their descriptor-to-destination copy argument.

Keep copyDescriptor's stored-blob hash/identity/link checks for Git dedup. Keep
withArtifactDescriptor in the runtime backend because live-file-read still calls
it. Keep reference-plan choose/target: Git/PR references and commit-bound paths
still select authorized contexts, while retired local taps still give C2's
upgrade refusal after source authorization. Do not delete called code to fit a
branch name, and do not remove identity/Connections, workflow or todo records.

Before deletion, run the migrated byte-only preview-capture and Git capture
regressions against the old implementation and commit that behavior pin. This
is pure deletion of uncalled code; no new user-visible failing bug is claimed.
Then run those same tests and the retained Git/legacy/live descriptor suites.

Use SKILL.md's resource check, fresh HOME/data and proof wrapper:

```sh
TMPDIR=/private/tmp bash .claude/skills/verify/proof-run.sh /absolute/new/bytes .claude/skills/verify/preview-capture.ts
TMPDIR=/private/tmp bash .claude/skills/verify/proof-run.sh /absolute/new/git-rpc .claude/skills/verify/lane-c-artifact-git-row.ts verify
TMPDIR=/private/tmp bash .claude/skills/verify/proof-run.sh /absolute/new/current-legacy .claude/skills/verify/retire-local-tap.ts verify
```

Require exit 0 and preserve JSON plus original logs. Byte durability includes actual
owned-child crash/recovery, no corrupt/excess-link overwrite, quota and failure
reservations, and caller-buffer mutation isolation. The real daemon Git proof checks
pinned source/read bytes, commit admission and revocation. The current/legacy proof reads
A then B then missing, with saved bytes still A and no additional rows/blobs. No mock
provider or production account is needed. Stop owned clients/daemons and retain evidence
before temporary data is removed.

After merge, run authorized idle-deploy and owner build readback, then repeat
the native proofs from the merged commit. Production build readback and isolated
byte proof are distinct; do not claim a production paired-human click or iOS run.
