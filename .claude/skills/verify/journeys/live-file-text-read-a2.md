# Live file references A2: current text and Markdown

Use the shared `proof-run.sh` setup with
`.claude/skills/verify/live-file-read-a2.ts` and a new absolute evidence directory.
It owns a port-0 test daemon, synthetic HOME/data, refusing gh stub, no model or
provider, and closes its socket/daemon in `finally`. No browser/mock port needed.

Call `file.reference.read` through the actual `operation.invoke` RPC door with
`sourceMessageOrCard`, exact `reference`, optional `offset`/`maxBytes` and `version`.
The first read returns A; edit the file, reopen without a version and require B;
continuing with the old version must return `file_changed`. Delete the source and
require `missing`, with no old-snapshot fallback. A publication without ask/work
links must read relative to its recorded Neo workspace. A missing conversation
must refuse without creating one.

Require byte-exact Unicode across chunks of at most 256 KiB, including a boundary
inside a multibyte character; continuation needs its version. Atomic replacement,
mid-read mutation and source revocation must withhold stale bytes. Require clear
unsupported-type, size-limit, missing-parent, unsafe/sensitive/symlink and absent
reference refusals. Non-human callers refuse before storage. Check zero new
artifact/identity rows and no artifacts directory/blobs.

After merge, read the owner build back and rerun the isolated RPC proof from the
merged commit. This follows the [maintainer-approved server/web acceptance split](https://github.com/lsm/HyperNeo/pull/9509#issuecomment-6570323070);
it does not require a paired-human RPC connection. Actual path clicks in a Neo reply belong
to A4. Do not forge a human caller or expand the worker socket's permissions.
Write A2.md only after merge, deployment/readback and the merged-version proof.

Run `tests/unit/1-core/pairing/human-reset-coordinator.test.ts` alongside the
live-file tests: readonly conversation lookup must preserve the audited default
conversation reservation method and its reset/receipt contract. Do not refresh
the audit hashes to hide a change to that dependency.
