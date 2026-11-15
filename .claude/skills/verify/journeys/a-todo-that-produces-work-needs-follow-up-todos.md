# A todo that produces work needs its follow-up todos before its ask ends

Use the shared metadata-only isolated setup in SKILL.md. No model, provider,
GUI or external service is needed. Set PROOF to
`.claude/skills/verify/todo-follow-up.ts`, create a fresh RUN and execute it
under `env -i` with NODE_ENV=test, a private HOME and HYPERNEO_DATA_DIR.

The helper starts an isolated daemon on an ephemeral non-8399 port and seeds
two finished asks on one synthetic Neo session. One ask's only todo is marked
`producesFollowUp` (a plan); the other is an ordinary todo. Both have an ended
wake turn, so auto-settle may take them.

Observable results, each asserted:
- after one real `refreshDriverWork` tick the ordinary ask is `done` and the
  plan ask stays `open`;
- two real pack sweeps queue exactly one mailbox wake for Neo, keyed
  `neo-follow-up-missing:…`, naming the ask and its finished todo;
- `neo.ask.settle` with status `done` on the plan ask is refused with
  `follow_up_missing`, and accepted once a later todo exists.

Retain `evidence/result.json`. The daemon is closed in finally.
