# Prepared worker OS write enforcement

Read the shared native-worker isolation setup in `../SKILL.md` first.

```bash
RUN=$(mktemp -d /private/tmp/hn-sb-XXXXXX)
mkdir -p "$RUN/home" "$RUN/bin"
env -i HOME="$RUN/home" PATH="$RUN/bin:$PATH" NODE_ENV=test \
  HYPERNEO_DATA_DIR="$RUN/data" LOG_LEVEL=warn \
  VERIFY_CLAUDE="$(command -v claude)" VERIFY_CODEX="$(command -v codex)" \
  bun .claude/skills/verify/worker-sandbox.ts "$RUN"
```

The helper owns an isolated daemon on an ephemeral non-8399 port and synthetic
Git repositories. Actual `work.start` RPC prepares the Claude clone and installs
its policy. Desktop registration uses a synthetic peer, never the human's GUI.
The installed Claude CLI runs that generated policy against a loopback model.
Codex uses the production desktop adapter with a synthetic bootstrap/handoff peer;
the real Codex CLI runs its generated thread configuration. This proves real OS
shell denial with adapter-generated policy, not native Desktop IPC or UI persistence.

Observe `evidence/{claude,codex}-observed.json`: both inside and private temp writes
succeed, outside writes fail. The corresponding stdout JSONL must contain the
shell's OS denial and nonzero outside status. Temp paths must stay inside each
worker's private root, including Claude's per-uid child directory. Long paths
cause Claude to fall back to shared `/tmp/claude-<uid>` and must fail this proof.
`codex-launch.json` and `codex-turn.json` retain both startup and opening policies.
The daemon closes in finally; no mock API ports or provider registration are needed.

Commit `ab59e77f7d` contains the failing reproduction before enforcement: real
Claude writes the synthetic outside file. The regression helper exits nonzero.

Read denial, credential/environment isolation, arbitrary MCP/native-tool containment
and Desktop UI behavior are not proven here. Codex `workspaceWrite` exposes no
per-path read deny; secret-read isolation is tracked separately in #8630.
Copy evidence to a persistent location before deleting the synthetic run/worktree.
