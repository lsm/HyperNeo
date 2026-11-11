# Coding stage preferences

Use the shared isolated daemon setup in `../SKILL.md`.

```sh
bash .claude/skills/verify/proof-run.sh "$EVIDENCE" .claude/skills/verify/coding-stage-preferences.ts
```

The helper saves all nine Write/Review/Verify preferences through authenticated
WebSocket RPC, rejects invalid values and checks human provenance after restart.
It exercises the retained Verify assignment selector directly through the daemon
DB gateway for default-first ordering, preferred targets and fallback explanations.
An unanswered repository retains its default without saving values.

Write target selection now lives in the coding skill. The retired public planner
is covered by `retired-write-plan.md`. This journey covers saved settings and the
shared selector, without claiming native worker dispatch or model availability.
