## Codex worker PR-link cleanup guidance

Run the production Codex start adapter against a real, headless Codex app-server
in a fresh synthetic home. No GUI or live thread is used. No HyperNeo daemon or
provider registration is needed for this driver-owned surface.

```bash
RUN=$(mktemp -d /private/tmp/hn-codex-pr-link-XXXXXX)
mkdir -p "$RUN/home"
env -i HOME="$RUN/home" CODEX_HOME="$RUN/home/.codex" PATH="$PATH" NODE_ENV=test \
  bun .claude/skills/verify/codex-pr-link-prompt.ts "$RUN"
```

The helper creates a synthetic project through the supported app-server API,
starts a thread through the production adapter, then resumes it in another
headless app-server as the Desktop handoff would. A local, unauthenticated model
stub records its input and deliberately rejects the request before any response
or tool execution. Both app-servers and the stub stop before the helper exits.

Read `evidence/proof.json`: the opening message and the model's user input must
contain the single guidance line naming `mcp__codex_app__list_artifacts`, GitHub
state checks and `mcp__codex_app__remove_artifact`, restricted to merged/closed
PRs on its own thread and forbidding direct edits to `~/.codex` state files.
The original task text must remain present. This proves delivery to worker
context; it does not claim the worker executed attachment tools or that a
Desktop window rendered the message.
