# Cited Neo resolution retires a worker card without human approval

Use SKILL.md's isolated wrapper from the worktree root:

```bash
TMPDIR=/private/tmp bash .claude/skills/verify/proof-run.sh /absolute/fresh/evidence-directory .claude/skills/verify/worker-question-triage.ts
```

The helper owns an ephemeral daemon and loopback Anthropic SSE model, fresh
HOME/data/DB, a refusing gh/open/ps stub and synthetic Neo/worker sessions. Both
session and title requests are redirected to that model. The only provider key
is a synthetic dev-proxy value stored through RPC in its disposable DB; no key
is put in the daemon environment. External registry MCP servers are disabled.
Its SDK sandbox is disabled only for this transport fixture; it does not prove
OS sandbox enforcement. There is no fixed port or real account/provider/app.

The worker's real session door reports a blocker. An unknown rule must leave
the card open and todo held. The scripted Neo model then calls the actual inline
MCP neo.question.resolve operation using a saved rule. Observe a retired card,
resolvedByAgent true, answeredByHuman false, a durable citation, an accepted
worker receipt and actual worker SDK consumption. A prior human answer can be
cited for another card; an earlier agent resolution must be refused as a human
source. Unit controls also cover foreign callers/answers and approval cards.

For a third card, make only this worker unavailable. Agent resolution must keep
its needs-human hold until accepted delivery. Remove the saved rule after the
resolution is recorded, restart only this daemon, restore the worker and let the
real refresh job retry. The citation and non-human provenance must survive;
each answer has exactly one consumed worker input, and the todo returns doing.
Identify actual Neo SDK model requests by its system prompt and verify that its
post-restart context contains the resolution and original citation.

Keep receipts.json, observed.json, model request files, proof.log and cleanup.json.
The helper closes only its own daemon/model/SDK resources and deletes their data
after saving evidence. The wrapper saves that evidence and removes the disposable
run. Native external apps, GUI rendering and duplicate-card merging are outside
this journey. Duplicate merging is tracked separately in
[#8955](https://github.com/lsm/HyperNeo/issues/8955).
