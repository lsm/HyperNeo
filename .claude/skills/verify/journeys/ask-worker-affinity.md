# Ask-affine free-worker reuse

Use SKILL.md's pinned runtime, resource check and synthetic-home wrapper.

```sh
bash .claude/skills/verify/proof-run.sh /absolute/fresh/evidence-directory \
  .claude/skills/verify/ask-worker-affinity.ts
```

The helper owns an isolated daemon on an ephemeral loopback port, stops its job
processor and invokes the real core todo-add/start operations. A synthetic pack
supplies exclusions through workerStartExclusions. Its dispatch reaches the real
work.start pipeline with adapter effects replaced by deterministic workers.
Candidate availability and ranking facts come from the production DB reader.
No native worker, model turn, provider key or external service is involved.

Require ask-worker-affinity.json to show the latest same-ask worker receiving
the follow-up, a busy latest worker yielding to another free same-ask worker,
an author excluded before independent review, the oldest-settled latest ask
winning different-ask reuse, and one new worker when no candidate is idle.
Every started todo must have its expected binding, doing state and one recorded
delivery input. The helper closes its daemon in finally; the wrapper retains
evidence and removes the temporary HOME/data. Native client behavior is covered
by existing adapter journeys, independently of this selection proof.
