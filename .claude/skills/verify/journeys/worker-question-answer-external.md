# External worker card answers retry only definite refusals

Use SKILL.md's metadata-only in-process wrapper, with no model or fixed HTTP port:

```bash
TMPDIR=/private/tmp bash .claude/skills/verify/proof-run.sh /absolute/fresh/evidence-directory .claude/skills/verify/worker-question-answer-external.ts
```

Pass `past` or `future` after the helper path (before the wrapper appends its
run directory) to select peer transcript timestamps one day behind or ahead of
the querying daemon. Run both modes sequentially with distinct evidence paths.

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

For another card with an 80-character title, let the peer accept the input but
close its connection before acknowledging it. Withhold the input's rollout entry temporarily. The adapter's
not_delivered result must lack notSent. Restart only this daemon and run its
real refresh handler: the card must stay pending with no new peer input. Publish
that accepted input into the synthetic rollout, append 160 newer unrelated inputs,
then refresh again. The card must reconcile the exact worker-answer marker through
work.read, accept delivery and return doing,
without resending. An extra refresh must leave the peer input count at three.
Before the uncertain attempt, the helper also forces a definite refusal and
records 60 inputs while the answer waits. Feed the native rollout through the
production index ingester before each owned refresh. Reconciliation must use the
exact marker on the assigned worker via work.read, without a timestamp bound.
Both default and old bounded work.status views intentionally omit the accepted
marker; reconciliation.json records that the card still becomes accepted.
Restart must preserve the claim so no uncertain send is replayed. Missing retained
peer history remains uncertain; elapsed time never authorizes a resend or hold release.

Related coverage and known limits:

- [#8874](https://github.com/lsm/HyperNeo/issues/8874): these two clock modes now
  prove exact card recovery beyond 8/50 inputs. The owning-peer lookup journey
  separately covers remote routing, Desktop alias mapping and owned Copilot history.
- [#8888](https://github.com/lsm/HyperNeo/issues/8888): a slow external send can
  outlast the card client's reply timeout after the answer is stored. This
  journey does not prove prompt acknowledgement with a slow peer; that follow-up
  must preserve durable delivery without duplicating the worker input.

The complete marker must survive the adapter's actual 160-character recentInputs
projection. External answer markers go first; HyperNeo's existing message payload
stays stable for durable idempotency receipts. Keep reconciliation.json with the
actual work.status projection, including a long card's shortened input text.
No marker or unavailable status is evidence of uncertainty, never permission to
resend. Other adapters without explicit pre-dispatch evidence remain conservative.

Keep immediate.json, observed.json, proof.log, run-status.json and cleanup.json.
The helper stops the daemon and every owned peer, removes synthetic native state,
HOME and daemon data, and exits after cleanup. The wrapper saves evidence outside
its disposable run and removes that run immediately. GUI rendering, real external
apps and agent triage remain unverified by this journey.
