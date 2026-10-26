# Only instance-owned work creates projects automatically

```bash
RUN=$(mktemp -d "$HOME/verify-owned-projects-XXXXXX")
mkdir -p "$RUN/home"
env -i HOME="$RUN/home" PATH="$PATH" NODE_ENV=test \
  HYPERNEO_DATA_DIR="$RUN/data" LOG_LEVEL=warn \
  bun .claude/skills/verify/owned-project-discovery.ts "$RUN"
```

Use a fresh directory outside the OS temporary tree because workspace discovery
excludes temporary repositories. The helper owns a test daemon, ephemeral
non-8399 listener, HOME/database, synthetic Git repositories and a synthetic
Codex workspace/thread database. Through the real `work.find` WebSocket operation,
foreign threads and tool-only roots remain discoverable but create no project or
alias, including with `workFeedScope: all`. Recording a synthetic owned thread
allows only that thread's repository and aliases to appear. Explicit project
creation and stored aliases remain intact. The built-in Inbox is excluded from
external-project counts. No model, credentials, real Desktop state, GUI or network
repository is used. `evidence/observed.json` retains RPC results and resource
closure; `projects.json` retains synthetic project/alias rows. Mixed-group alias
isolation, native sessions and remote-ID collisions are also pinned by unit tests.
Copy evidence out, then remove the synthetic run directory.
