# Direct-superpipe migration plans

Per-area deep-dive plans for converting hand-rolled imperative flows to direct
superpipe composition (ADR 0004). Produced from the #1414 direct-superpipe
inventory; no source code is changed by these plans.

| Doc | Area | Sites |
| --- | --- | --- |
| [external-events.md](external-events.md) | GitHub normalizers, event tiers, digest rendering | 8 |
| [storage.md](storage.md) | `sdk-message-admission.ts` message admission | 1 |
| [agent-routing.md](agent-routing.md) | Agent-layer routing (turn-end, query-retry, delivery, steer, context reset) | 6 |
| [agent-gates-recovery.md](agent-gates-recovery.md) | Agent-layer gates & recovery (limit errors, loops, breakers, fallbacks, acks) | 11 |
| [space-runtime-tools-goals.md](space-runtime-tools-goals.md) | Space runtime staged flows, tools/RPC unification, goals | 18 |
| [web.md](web.md) | Web routing/parsers/status helpers and `useSendMessage` | 13 |

Each plan records the combinator fit (`decisionRun`, `stagedRun`, or raw
superpipe transform — no new combinators), per-site input/output and pure-core
designs, shell/effect wiring, tests, risks, migration order, and open
questions. Sites deliberately excluded from migration (state machines, folds,
hot per-row paths) are listed in the inventory artifact, not here.
