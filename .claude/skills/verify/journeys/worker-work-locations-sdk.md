# SDK workers receive one work-location section

Use SKILL.md's shared isolated wrapper:

```sh
TMPDIR=/private/tmp bash .claude/skills/verify/proof-run.sh "$EVIDENCE" .claude/skills/verify/sdk-work-locations.ts
```

The helper owns an ephemeral daemon and scripted Anthropic endpoint, registers a
synthetic credential only through RPC, disables external MCP servers and launches
an ordinary HyperNeo worker through work.start. Its initial task text comes from
the same buildCustomAgentTaskMessage used for Space SDK workers. It downloads and
runs the real SDK; workflow scheduling and Desktop UI are not exercised.

The endpoint address is set before importing the daemon because provider-service
captures it at module initialization. Captured worker requests must contain the
task marker, the host system-location block, workspace and HYPERNEO_WORKTREES, with
exactly one Runtime Location section across system and user messages. Auxiliary
SDK requests without the host system block are recorded but not called worker
requests. The regression received two sections before removing the user-message
copy. Unit regressions cover direct-task and workflow-worker input assembly.

Inspect sdk-work-locations.json and proof.log. The helper closes its transport,
daemon and model in finally; the wrapper preserves evidence and deletes its
synthetic HOME/data. No real credential, transcript or live daemon is read.
