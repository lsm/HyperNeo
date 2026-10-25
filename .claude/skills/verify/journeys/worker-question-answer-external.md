# External worker card answers retry only definite refusals

Use SKILL.md's metadata-only in-process wrapper, with no model or fixed HTTP port:

```bash
TMPDIR=/private/tmp bash .claude/skills/verify/proof-run.sh /absolute/fresh/evidence-directory .claude/skills/verify/worker-question-answer-external.ts
```

The helper owns a fresh daemon, HOME/data/DB and synthetic Codex SQLite state,
rollout and Desktop Unix socket. Its ps shim reports only the synthetic Desktop;
its open and gh shims refuse host app launches and GitHub access. No credentials,
real native state, GUI or provider turn is involved.

The production Codex adapter receives the human's answer through the real
neo.question.answer RPC. Its synthetic Desktop peer accepts a turn and records
that exact input. The card must show accepted and the todo doing before return.

Stop only that peer, then answer a new card. The adapter's failed ownership
connection made no dispatch: notSent is true, so the delivery claim must be
released while the card stays pending and the todo stays needs-human. Restore
the peer and make only the owned driver's persisted refresh job due; run one
processor tick. The real handler must retry, deliver and resume.

For another card, let the peer accept the input but close its connection before
acknowledging it. Withhold the input's rollout entry temporarily. The adapter's
not_delivered result must lack notSent. Restart only this daemon and run its
real refresh handler: the card must stay pending with no new peer input. Publish
that accepted input into the synthetic rollout, then refresh again. work.status
must reconcile the exact worker-answer marker, accept delivery and return doing,
without resending. An extra refresh must leave the peer input count at three.
No marker or unavailable status is evidence of uncertainty, never permission to
resend. Other adapters without explicit pre-dispatch evidence remain conservative.

Keep immediate.json, observed.json, proof.log, run-status.json and cleanup.json.
The helper stops the daemon and every owned peer, removes synthetic native state,
HOME and daemon data, and exits after cleanup. The wrapper saves evidence outside
its disposable run and removes that run immediately. GUI rendering, real external
apps and agent triage remain unverified by this journey.
