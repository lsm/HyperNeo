### Neo home save (journey 35)

On a fresh isolated daemon from Launch, run
`bun .claude/skills/verify/neo-home-save.ts <port> "$RUN"`.
The helper seeds synthetic identity and transcript data, then calls the actual
`neo.home.save` RPC. First save creates the local bootstrap plus one document
commit, preserving leading spaces and trailing newlines. Repeating identical
content must return the same commit. Malformed Unicode and unconfirmed direction changes
must be refused without changing the document or HEAD.

A synthetic missing identity forces commit failure: the original document must
remain byte-for-byte intact and retry must succeed after configuring identity.
A read-only fixture directory forces an actual write-before-file-creation EACCES;
cleanup must preserve that error. An overlong filename must retain ENAMETOOLONG.
Evidence: `evidence/neo-home-save.json`. Focused contracts cover the other token
forms, ignored/internal/outside/symlink paths, concurrent saves and caller ownership.
No real credentials, remote, provider/model turn or GUI are used. Content checks apply only to this operation. Neo owns its home and may repair or commit it directly with normal tools and git. Credential-like content is refused when origin is configured; local-only content belongs to Neo. Stop the isolated daemon and mock with `stop.sh`.

Repeat journey 35 in a fresh run with final argument `unicode` to
`neo-home-save.ts`. Unpaired surrogate input must return a Unicode content
refusal on both attempts, without a file or new commit. The helper then seeds
only a synthetic non-UTF-8 document and forces commit failure: rollback must
preserve every original byte and leave clean status. Valid Unicode is encoded
and compared as UTF-8 bytes; existing files are never decoded for rollback.

Repeat journey 35 in another fresh run with final argument `ignore-repair`.
The helper removes its fixture ignore in a local commit, then calls save with
untracked coordinator transcripts present. Save must repair the ignore and commit
the curated document while preserving and never tracking the transcripts. An unrelated pending direction draft must remain on disk, outside both the ignore-repair and document commits.
Staged transcripts and unrelated drafts remain untouched while the document save succeeds.

Repeat with final argument `runtime` to seed `.claude/` and `worktrees/` before
the first save, alongside `.coordinators/`. The helper does not call the init RPC explicitly. Save
must bootstrap, commit only curated bytes and ignore all three runtime folders;
the helper checks their unchanged bytes and empty tracked-file lists. The same
run retains malformed-Unicode/confirmation refusals and untracked-draft/rollback
checks. Before the first-use fix this mode records a dirty refusal before HEAD
exists. Unit contracts also exercise repair from a committed coordinator-only
ignore, preserving staged runtime files without adding them to the save commit.
