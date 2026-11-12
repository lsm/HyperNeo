# Sent messages cannot be edited

Use shared isolation in `../SKILL.md`. No model or GUI is required. From the
worktree root:

```sh
RUN=$(mktemp -d /private/tmp/hn-pub-edit-removed-XXXXXX)
mkdir -p "$RUN/home"
env -i HOME="$RUN/home" PATH="$RUN/bin:$PATH" NODE_ENV=test \
  HYPERNEO_DATA_DIR="$RUN/data" LOG_LEVEL=error \
  bun .claude/skills/verify/publication-edit-removed.ts "$RUN"
```

The helper owns an ephemeral daemon, a fresh database and a gh stub that refuses
every call. Through the real operation MCP handler it publishes a message as root
Neo, then calls `neo.publication.edit` on it. The registry has no such operation
and the call fails with `unknown_operation`. A correction published with
`neo.publication.publish` arrives as a second message; the first keeps its text
and neither row gains revisions. Evidence: `evidence/publication-edit-removed.json`.

Rows stored before the removal keep their revisions; the conversation read unit
test covers reading them.
