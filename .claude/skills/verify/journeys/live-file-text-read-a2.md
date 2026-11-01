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

After merge and deployment, read the build through the owner socket. The live
acceptance additionally needs an authorized paired-human RPC connection and a
stored readable publication naming an owned synthetic probe file. Read A, edit
only that probe, reopen for B, delete it and require `missing`; save exact replies.
Do not route the probe through the restricted worker session socket, forge a
human caller, read credentials, or use someone else's source/file. Ask Neo to
arrange the existing authorized human RPC door when it is unavailable here.
Keep the live probe separate from A2.md, which is written only after acceptance.
