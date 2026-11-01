# Live file references A1: public source authorization and location

Run `proof-run.sh` with a new absolute evidence directory and
`.claude/skills/verify/public-file-source-a1.ts`. Shared setup and cleanup are in
`SKILL.md` and the runner. The proof starts an isolated daemon on a free port,
stops the job processor, uses only synthetic sessions/files, and closes its
WebSocket and daemon in `finally`.

Require the existing `artifact.reference.resolve` and `artifact.file.read` RPCs
to return the ordinary worker report bytes. A raw Neo SDK prompt, runtime text
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

A1 keeps the current snapshot protocol. Live read/edit/delete is not applicable
here and is covered by A2. Before marking A1 done, record the merged and deployed
build plus the isolated proof evidence; do not claim a live-read endpoint exists.
