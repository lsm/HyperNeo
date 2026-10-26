### Human-approved standing-rule edits

```bash
RUN=$(mktemp -d /private/tmp/hn-rule-answers-XXXXXX)
mkdir -p "$RUN/home"
env -i PATH="$PATH" HOME="$RUN/home" HYPERNEO_DATA_DIR="$RUN/data" NODE_ENV=test \
  bun .claude/skills/verify/neo-rule-answers.ts 9355 "$RUN"
```

This helper starts a real isolated daemon and uses its MCP and WebSocket
`operation.invoke` doors. A system-triggered direct `neo.rule.save` is refused.
Direct agent saves require a consumed human `yes` replying to an immutable
`neo.rule.ask` proposal for the same add/remove arrays. A greeting cannot authorize
an edit, and even a valid approval cannot authorize different rule content.
The approving message need not quote the rule text. Re-saving an already-applied
removal or replacement returns the current rules without replaying old edits. The saved `standingRuleSources`
reference identifies that actual human message and session and survives restart.
Button and delayed applyAnswer approvals instead retain their real questionId,
which links to the recorded human yes and immutable proposal; they never invent
a human message ID.
A stale worker-permission Settings update cannot overwrite the saved consent
reference. The helper also saves 25 additional rules and observes all of them in `neo.snapshot`.

The preferred `neo.rule.ask {askId,requestId,add?,remove?}` path generates a yes/no
question and atomically binds its immutable exact edit. No answer leaves the
rules unchanged. Human yes applies only the stored edit; an agent cannot answer,
replace the proposal after consent or pass new edit fields to the questionId-only
`neo.rule.applyAnswer`. Both the human consent and resulting `neo.snapshot`
standingRules survive restart. Successful chat consent must also deliver the
updated `state.settings` event over the connected WebSocket; the helper waits
for the exact new rule in this projection, rather than accepting a DB read as
proof that connected clients updated. Pending proposal retries reuse requestId; closed
questions require a new requestId. Evidence is retained even on failure in
`evidence/observed.json`; each daemon and socket closes in `finally`.

Unit contracts also replace one of twenty rules while keeping the other nineteen,
refuse guessed/queued/nonhuman direct-save triggers, and roll back consent and
all edits on infrastructure failure. A stale proposal (a missing removal) records the human answer without changing rules. Chat sends
remain accepted and notify Neo; `neo.rule.applyAnswer` returns the typed refusal.
The real helper exercises a stale chat yes through `neo.message.send`, and the
unit journey checks notification and retry idempotency for stale removals.
Only synthetic fixtures are used. This journey
proves the daemon operation and snapshot surfaces; GUI rendering, model choices,
notification completion and deployment are not verified. Neo's default guidance
asks for consent first; the existing direct human-message path remains available.
