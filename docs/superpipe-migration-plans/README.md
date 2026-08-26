# Direct-superpipe migration plans

Per-area deep-dive plans for converting hand-rolled imperative flows to direct
superpipe composition (ADR 0004). Produced from the #1414 direct-superpipe
inventory; no source code is changed by these plans.

| Doc | Area | Sites |
| --- | --- | --- |
| [external-events.md](external-events.md) | GitHub normalizers, event tiers, digest rendering | 8 |
| [storage.md](storage.md) | `sdk-message-repository.ts` save methods and `message-delivery-outbox.ts` delivery turn | 4 |
| [agent-routing.md](agent-routing.md) | Agent-layer routing (turn-end, query-retry, delivery, steer, context reset) | 6 |
| [agent-gates-recovery.md](agent-gates-recovery.md) | Agent-layer gates & recovery (limit errors, loops, breakers, fallbacks, acks) | 11 |
| [space-runtime-tools-goals.md](space-runtime-tools-goals.md) | Space runtime staged flows, tools/RPC unification, goals | 18 |
| [web.md](web.md) | Web routing/parsers/status helpers and `useSendMessage` | 13 |

Each plan records the combinator fit (`decisionRun`, `stagedRun`, or raw
superpipe transform — no new combinators), per-site input/output and pure-core
designs, shell/effect wiring, tests, risks, migration order, and open
questions. Sites deliberately excluded from migration (state machines, folds,
hot per-row paths) are listed in the inventory artifact, not here.

Each plan also ends with a **Focused PR breakdown**: the slicing of that area
into small, independently shippable implementation PRs (scope, tests, and
dependencies per slice), following the standing budget of ≤ ~1.5k changed
lines / ≤ 8 source files per PR — split further before opening rather than
growing past budget mid-review.

## Composition rule (from review)

Pipelines are composed per **complete business path**, not per helper
function: one directly named pipeline per business operation, mixing
decision/transform/effect stages (CLAUDE.md / AGENTS.md). Where a plan section
describes one function of a multi-function operation (e.g. the classifier and
finalizer halves of query-retry routing, or the per-kind transforms of GitHub
normalization), those sections are stage groups within the single operation
pipeline (`route-query-retry`, `ingest-github-webhook`,
`ingest-github-polling-row`), not separately-run pipelines. The per-site
headings exist for planning granularity only.
