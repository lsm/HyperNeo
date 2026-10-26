# Shared Neo todo completion checks

Use the isolated metadata-only setup in the shared verify skill. The helper owns
an ephemeral daemon port, synthetic database and HOME, with no model or provider.
It closes its WebSocket and daemon in finally. No browser or visual layout proof
is needed for this check-reader slice.

```sh
bash .claude/skills/verify/proof-run.sh \
  /absolute/fresh/evidence-directory .claude/skills/verify/core-todo-checks.ts verify
```

The real WebSocket operation door adds todos while only life-admin is enabled.
Every completion sentence comes from the check. A missing file and missing
artifact close unverified; creating the file or registering the artifact lets
the same completion door mark them done. Two synthetic cards answered through
the human RPC door prove that no does not complete a todo and yes does.

The deployed check reads `system.build`: the exact running commit passes without
GitHub, an ancestor passes, and a diverged commit does not. A refusing GitHub stub
additionally permits only synthetic HyperNeo commit comparisons; its fixtures
never query GitHub or run a deployment script. Unit tests separately cover foreign
ask/artifact contexts, malformed checks, regular files and pure judgement replay.
The helper saves RPC receipts, final state and stub calls. The wrapper saves
evidence outside the disposable run and removes its data after cleanup.
