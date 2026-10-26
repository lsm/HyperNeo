# Card question replies persist one linked publication

Use shared isolation in `../SKILL.md`. No model or GUI is required for this
 daemon/shared-type slice. From the worktree root:

```sh
RUN=$(mktemp -d /private/tmp/hn-card-reply-XXXXXX)
mkdir -p "$RUN/home"
env -i HOME="$RUN/home" PATH="$RUN/bin:$PATH" NODE_ENV=test \
  HYPERNEO_DATA_DIR="$RUN/data" LOG_LEVEL=error \
  bun .claude/skills/verify/card-reply-daemon.ts "$RUN"
```

This helper checks persistence and explicit caller context; it does not exercise
the runtime's capture of consumed input. Run `card-reply-consumed-turn.md` for
the actual SDK turn, including a teammate input consumed after human intake.

The helper owns an ephemeral daemon and a gh stub that refuses every call. It
seeds a synthetic #8442 sign-off ask, submits real quoted human intake through
`neo.message.send`, and marks those synthetic prompts consumed with the normal
message repository. The registered MCP question operation receives a recorded
consumed-input identity, deliberately omitting `replyTo` on the question.
A successful choice question must create an ordinary typed publication containing
only the localized notice and a short title. Options stay on the question and
input status must remain un-answered.

Repeating the operation must reuse its question and publication. Replacing the
question must retarget that row while retaining its sequence. Restarting the
isolated daemon and retrying must still reuse it. A manual publication with the
same typed association updates that row. A later human input gets its own row;
background questions and rejected foreign IDs produce none. The helper records
`evidence/card-reply.json` and closes its daemon in finally.

Focused Vitest contracts also cover Chinese notice text, start-question rewording,
old mutation retries after replacements/rewording, and transaction rollback when
publication persistence fails. No web/iOS rendering or navigation, external
provider turn, arbitrary ask.outcome/todo-text updates, credential files, live
database/copy or live daemon are exercised. Those UI changes are separate work.

The daemon proof also edits the first notice through `neo.publication.edit`
before replacing the question. Retargeting must preserve edit metadata and
archive the edit identity so retrying the edit neither rewinds the notice nor
duplicates revision IDs. After restart/manual reuse, the existing web publication
reader must still accept the entire returned page. Unit regressions exercise
replacement, start rewording and manual reuse with retained provenance/awaiting.
