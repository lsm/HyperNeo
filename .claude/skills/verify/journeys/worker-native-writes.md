# Prepared Claude workers retain native path denies

Read shared SKILL.md first. Supply the installed Claude Code binary explicitly;
only that executable is used, never its host configuration or credentials.
Run from the worktree root with a fresh synthetic directory:

```bash
RUN=$(mktemp -d /private/tmp/hn-native-writes-XXXXXX)
mkdir -p "$RUN/home" "$RUN/bin"
env -i HOME="$RUN/home" PATH="$RUN/bin:$PATH" NODE_ENV=test \
  HYPERNEO_DATA_DIR="$RUN/data" LOG_LEVEL=warn \
  bun .claude/skills/verify/worker-native-writes.ts "$RUN" /absolute/path/to/claude
```

The helper owns an isolated daemon, synthetic Git repos, fake Desktop handoff and
loopback scripted model. Its synthetic apiKeyHelper supplies only a loopback
fixture string; no provider key is inherited or placed in the daemon environment.
No GUI, real settings, credentials or live daemon are accessed.

Actual work.start prepares a standalone clone outside main and installs the native
Edit(path) policy. The installed headless CLI loads that file normally, with no
--settings policy argument. Native Edit and Write into main both return visible
permission errors; own-file edits/writes succeed. Replacing the policy is denied.
The helper restarts only its isolated daemon, creates a later sibling, and resumes
the same real CLI session, including a requested bypass mode that the policy disables. The older clone must now deny the sibling too. Generated
settings remain excluded from Git status. Paths include literal glob metacharacters.

Preserve evidence/observed.json and CLI stdout/stderr. Unlisted outside directories
are explicitly writable in this slice, as the proof records. Bash/MCP containment
and real Desktop rendering are not verified; the next OS-sandbox slice closes the
outside-directory gap for shell tools. The helper stops its owned servers in finally.
