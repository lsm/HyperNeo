# Home-relative paths in Neo replies open authorized HTML

Use the shared metadata-proof wrapper in SKILL.md, from the worktree root:

```bash
PROOF=.claude/skills/verify/preview-home-reference.ts
bash .claude/skills/verify/proof-run.sh /absolute/fresh/evidence-directory "$PROOF" verify
```

No provider, browser, HTTP listener, credentials or model turn is needed. The
helper seeds only a migrated synthetic database and files under its disposable
HOME. It publishes an inline-code `~/HyperNeo/引用配色/quote-colour-options.html`
reference without an artifact attachment, bound through its originating ask to
the configured synthetic workspace. It invokes the real paired-human operation
registry, not an injected capture implementation.

Require `home-reference.json` to report `passed`, `previewDocumentServed`,
`sameAbsoluteSnapshot`, `sourceBound` and `ownershipRechecked`. The first click
must create an artifact from an unregistered file; artifact.file.read returns
the complete HTML bytes and artifact.file.html serves an inert preview document
containing its heading. The equivalent absolute reference has the same hash.

The helper also requires refusal, without new artifacts, for `~other/`, bare
`~`, outside-root files, raw/encoded traversal (even when the final path would
be inside the root), symlinks, secret paths, invalid HTML bytes, and a sparse
file over the existing capture limit. The `~other` fixture deliberately exists
as a literal workspace folder. References absent from stored text or detached
from their originating ask remain unavailable. Existing registration suites
cover quota and ownership gates; this change does not alter those gates.

Run preview-resolve.test.ts plus preview-candidates.test.ts and preview-policy.test.ts
for source/context and root-policy regression coverage. The new native check is
included in preview-resolve.test.ts. The wrapper retains JSON/log evidence before
removing all synthetic files, including the sparse oversized file and database.

Run the focused suites with the daemon's Node-based Vitest runner (not Bun's
Vitest launcher, which conflicts with the SQLite compatibility alias):

```bash
cd packages/daemon
node_modules/.bin/vitest run tests/unit/1-core/operations/preview-{resolve,candidates,policy,safe-open,capture,register,reads}.test.ts
```

This proves real resolver/capture/read/HTML operation results, not browser layout
or theme rendering. Browser proof remains pending when the environment blocks
it; do not retry a browser repair or claim light/dark screenshots from this proof.
