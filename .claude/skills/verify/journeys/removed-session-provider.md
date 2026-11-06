# Removed session providers and retained worker drivers

Follow shared isolation and resource rules in SKILL.md. Run from the worktree root.

```bash
TMPDIR=/private/tmp bash .claude/skills/verify/proof-run.sh \
  /absolute/fresh/evidence-directory .claude/skills/verify/removed-session-provider.ts
bash .claude/skills/verify/session-provider-removal-drivers.sh
```

The daemon helper owns ephemeral ports, a fresh HOME, workspace and database. It
creates a synthetic old provider, saves a session with its old provider selection
through the DB facade, then stops and boots the actual daemon again. The public
provider list shows it unavailable. Sending a message through WebSocket RPC must
produce one dead delivery with zero retries and a plain retirement error.
The saved message must be failed, the visible retirement notice must explain how
to recover, and its provider selection must stay unchanged. The daemon must still
answer RPC. Evidence
is provider-removal.json. Both daemon instances and the WebSocket close in finally.
The wrapper saves evidence before removing synthetic data. No model call is needed.

The driver script uses the repository's Vitest configuration in an isolated HOME
and temporary directory, with a refusing GitHub stub. It covers the existing
Codex, Copilot and temporary discovery-adapter tests. OpenCode is absent from
the registry. Copilot discovery still uses --acp until the following SDK slice.
Use the Copilot owned-history journey separately for its real daemon/RPC path.
Real accounts and real external worker turns are outside this synthetic proof.
