# A merged design needs its follow-up todos before its ask ends

Use the shared metadata-only isolated setup in SKILL.md. No model, provider,
GUI or external service is needed. Set PROOF to
`.claude/skills/verify/design-follow-up.ts`, create a fresh RUN and execute it
under `env -i` with NODE_ENV=test, a private HOME and HYPERNEO_DATA_DIR.

The helper starts an isolated daemon on an ephemeral non-8399 port and seeds
two finished asks on one synthetic Neo session. One ask's only todo merged a
PR recorded as changing design docs; the other merged an ordinary PR. Both
have an ended wake turn, so auto-settle may take them.

Observable results, each asserted:
- after one real `refreshDriverWork` tick the ordinary ask is `done` and the
  design ask stays `open`;
- two real coding-pack sweeps queue exactly one mailbox wake for Neo, keyed
  `neo-design-follow-up:…`, naming the design PR and its Change section;
- `neo.ask.settle` with status `done` on the design ask is refused with
  `design_follow_up_missing`, and accepted once a later todo exists.

Retain `evidence/result.json`. The GitHub CLI is the shared stub, so the
sweep's ledger reads fail harmlessly; the wake does not depend on them. The
daemon is closed in finally.
