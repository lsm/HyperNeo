# Codex worker compaction

Use Bun 1.4.4 and a Codex CLI that supports the app-server. The probe starts a real app-server over stdio, completes one turn through a synthetic loopback model, then calls the daemon's compaction adapter and checks the matching completion notification. The app-server has an empty home and receives no provider credentials.

```bash
codex_bin=$(command -v codex)
run=$(mktemp -d)
trap 'rm -rf "$run"' EXIT
mkdir "$run/home" "$run/data"
env -i PATH="$PATH" NODE_ENV=test HOME="$run/home" CODEX_HOME="$run/codex" \
  HYPERNEO_DATA_DIR="$run/data" DB_PATH="$run/data/daemon.db" \
  bun .claude/skills/verify/codex-worker-compaction.ts "$run" "$codex_bin"
```

A pass prints the matching notification and the number of compaction model requests. The probe exits nonzero if the app-server never confirms compaction.
