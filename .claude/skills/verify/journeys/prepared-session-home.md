# Prepared HyperNeo sessions stay under their repo project

Use the shared metadata-only isolation setup in `../SKILL.md`:

```bash
RUN=$(mktemp -d /private/tmp/hn-prepared-home-XXXXXX)
mkdir -p "$RUN/home" "$RUN/bin"
env -i HOME="$RUN/home" PATH="$RUN/bin:$PATH" NODE_ENV=test \
  HYPERNEO_DATA_DIR="$RUN/data" LOG_LEVEL=warn \
  bun .claude/skills/verify/prepared-session-home.ts "$RUN" > "$RUN/proof.log" 2>&1
cat "$RUN/proof.log"
```

The helper owns a real daemon on an ephemeral non-8399 port and synthetic Git
repositories. It starts a prepared HyperNeo coding session through `work.start`,
then reads `session.list` and applies the web sidebar's actual `projectRootOf`
projection. Observe the clone under `data/projects/<repo>/worktrees/<session id>`,
the sidebar group equal to the source project, and no code clone under `data/Neo`.
`evidence/observed.json` retains the RPC replies, session and projected group.
The same run checks the fetched pinned base, independent object inodes and dirty
source preservation. Inventory snapshot and session inspection must report the
same source project. Starts from a trailing-slash repo path must use that same
project too. Root and trailing-slash session records must archive/delete while
retaining their clones, preserving the existing lifecycle behavior. Subdirectory
starts are not covered: preparation currently refuses to clone a non-root folder.
Clone release is deferred until the separate follow-up after #8642.
The custom model catalog uses a closed loopback endpoint; queued SDK delivery may
retry locally, but no successful model response, credentials, external GitHub
access or browser rendering is claimed. GitHub is stubbed using shared gh-stub.sh.
The daemon closes in finally. Preserve evidence before deleting the synthetic run.
