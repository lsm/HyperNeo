# Live file references A1: public source authorization and location

Run `proof-run.sh` with a new absolute evidence directory and
`.claude/skills/verify/public-file-source-a1.ts`. Shared setup and cleanup are in
`SKILL.md` and the runner. The proof starts an isolated daemon on a free port,
stops the job processor, uses only synthetic sessions/files, and closes its
WebSocket and daemon in `finally`.

Require `file.reference.read` to return the ordinary worker report bytes.
C2 retires local capture: separately require `artifact.reference.resolve` to
return client_upgrade_required for that same authorized reference. A raw Neo SDK prompt, runtime text
added to a human intake, non-renderable SDK messages and publications outside the
public conversation must not supply file references. The saved human intake's
original text and the current conversation's publication must remain usable.

Check the source reader returns the recorded owner and that owner's workspace,
including two different workspaces with the same report basename. A remote todo
must have no local workspace and its reference must refuse local capture; a
missing workspace must not fall back to process cwd. Non-human callers must be
refused before any storage read. Source preparation must not create artifact
rows. Existing historical publication, native workspace and file safety checks
remain covered by the existing preview tests.

The original A1 acceptance kept the snapshot protocol, which C2 has now retired.
This source-authorization proof uses current reads; read/edit/delete remains
covered separately by A2 and the retirement proof. Before marking A1 done, record the merged and deployed
build plus the isolated proof evidence; do not claim a live-read endpoint exists.
