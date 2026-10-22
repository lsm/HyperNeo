### Neo home save (journey 35)

On a fresh isolated daemon from Launch, run
`bun .claude/skills/verify/neo-home-save.ts <port> "$RUN"`.
The helper seeds synthetic identity and transcript data, then calls the actual
`neo.home.save` RPC. First save creates the local bootstrap plus one document
commit, preserving leading spaces and trailing newlines. Repeating identical
content must return the same commit. Credential-like content, direction changes
and dirty human files must be refused without changing the document or HEAD.

A synthetic missing identity forces commit failure: the original document must
remain byte-for-byte intact and retry must succeed after configuring identity.
A read-only fixture directory forces an actual write-before-file-creation EACCES;
cleanup must preserve that error. An overlong filename must retain ENAMETOOLONG.
Evidence: `evidence/neo-home-save.json`. Focused contracts cover the other token
forms, ignored/internal/outside/symlink paths, concurrent saves and caller ownership.
No real credentials, remote, provider/model turn or GUI are used. Content checks
apply only to this operation; environment/filesystem limits must bound general
writes. Read behavior, human confirmation support and remote sync remain later
slices. Stop the isolated daemon and mock with `stop.sh`.

Repeat journey 35 in a fresh run with final argument `unicode` to
`neo-home-save.ts`. Unpaired surrogate input must return a Unicode content
refusal on both attempts, without a file or new commit. The helper then seeds
only a synthetic non-UTF-8 document and forces commit failure: rollback must
preserve every original byte and leave clean status. Valid Unicode is encoded
and compared as UTF-8 bytes; existing files are never decoded for rollback.

Repeat journey 35 in another fresh run with final argument `ignore-repair`.
The helper removes its fixture ignore in a local commit, then calls save with
untracked coordinator transcripts present. Save must repair the ignore and commit
the curated document while preserving and never tracking the transcripts.
Staged transcripts and unrelated human changes still cause dirty refusal.

Repeat with final argument `runtime` to seed `.claude/` and `worktrees/` before
the first save, alongside `.coordinators/`. There is no explicit init RPC. Save
must bootstrap, commit only curated bytes and ignore all three runtime folders;
the helper checks their unchanged bytes and empty tracked-file lists. The same
run retains credential/confirmation refusals and dirty-human-file/rollback
checks. Before the first-use fix this mode records a dirty refusal before HEAD
exists. Unit contracts also exercise repair from a committed coordinator-only
ignore and retain refusal for staged runtime files.
