# Direct-superpipe migration plans

Per-area deep-dive plans for converting hand-rolled imperative flows to direct
superpipe composition (ADR 0004). Produced from the #1414 direct-superpipe
inventory; no source code is changed by these plans.

| Doc | Area | Sites |
| --- | --- | --- |
| `external-events.md` | GitHub normalizers, event tiers, digest rendering | 8 |
| `github-poll-cycle.md` | GitHub poll-cycle cursor machine (extraction map; no pipeline) | 6 |
| [storage.md](storage.md) | `sdk-message-repository.ts` save methods and `message-delivery-outbox.ts` delivery turn | 4 |
| `agent-routing.md` | Agent-layer routing (turn-end, query-retry, delivery, steer, context reset) | 6 |
| `agent-gates-recovery.md` | Agent-layer gates & recovery (limit errors, loops, breakers, fallbacks, acks) | 11 |
| `space-runtime-tools-goals.md` | Space runtime staged flows, tools/RPC unification, goals | 18 |
| [task-agent-manager.md](task-agent-manager.md) | `task-agent-manager.ts` cluster map, slice ladder, ADR-0004 risks | 19 |
| `web.md` | Web routing/parsers/status helpers and `useSendMessage` | 13 |

"Sites" counts measured clusters/flow groups per area (the inventory's unit
of analysis), not pipeline candidates — several clusters stay plain or remain
class-owned, and each plan's candidate table is the authoritative split.

Each plan records the named business-operation pipelines, per-site input/output
and pure-core designs, shell/effect wiring, tests, risks, migration order, and
open questions. A plan may note where an existing combinator (`decisionRun`,
`stagedRun`) happens to fit, but it must not pre-classify the flow as
"decision" versus "staged"; the required record is the complete business-path
composition (CLAUDE.md / AGENTS.md). No new combinators are introduced. Sites deliberately excluded from migration (state machines, folds,
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
