# Root Neo Bash stops at two minutes

Use SKILL.md's resource guard and isolated proof wrapper. No real provider,
live daemon, database or credential is used. From the worktree root:

```sh
TMPDIR=/private/tmp bash .claude/skills/verify/proof-run.sh "$EVIDENCE" .claude/skills/verify/neo-bash-cap.ts --full
```

The helper owns a synthetic daemon and loopback scripted model on ephemeral
non-8399 ports. It registers a synthetic provider through RPC, persists a root
Neo binding and an ordinary worker, and builds their actual SDK query options.
Only the native SDK child receives the loopback API key. The real SDK receives
a Bash call requesting timeout 600000. Root Neo's command prints its effective
timeout environment, sleeps 125 seconds, and attempts a completion marker.

Read neo-bash-cap.json and root-events.jsonl: root Neo must inherit 120000 for
both timeout variables despite saved 600000 defaults, disable SDK background
tasks for root Neo only, return the native timeout
failure around 120 seconds without completing, and receive the requested
additional context in the next actual model request. The ordinary worker must
retain 600000, finish its short command and receive no coordinator-only context.
The script records native hook inputs without synthesizing a timeout signal.
The first real full run reproduced automatic backgrounding at 120000; timeout
environment values alone do not terminate the command in this SDK.
Without --full, it only proves environment propagation, not command termination.

Focused QueryOptionsBuilder tests also pin project/focused and unbound sessions,
ordinary failures, user interruption and output merely mentioning a timeout.
The helper closes both SDK queries, RPC transport, daemon and mock in finally;
the wrapper saves evidence before removing the synthetic HOME/data. This proves
native tool enforcement and model-visible context, not a model's compliance with
the handoff guidance, external downloads, GUI installs or production rollout.
