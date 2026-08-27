# ADR 0005: Capability Dispatcher

## Status

Accepted — 2026-08-27. Tracks epic #3129. This ADR is the normative design record
for the CD 00–CD 17 slice series.

## Context

### Current tool surface

Space agent capabilities are exposed as a large typed tool surface.
`createSpaceAgentToolHandlers` in
`packages/daemon/src/lib/space/tools/space-agent-tools.ts` builds 86+ `tool(...)`
entries for the Space/coordinator role;
`packages/daemon/src/lib/space/tools/node-agent-tools.ts` and
`packages/daemon/src/lib/space/tools/task-agent-tool-schemas.ts` add node-agent and
task-agent variants. The 293-method typed census is a coverage checklist, not a
curated prompt surface.

This creates several problems:

1. **Prompt bloat.** Every role receives the full (or filtered but still large)
   tool list; descriptions are generic, not role-tuned.
2. **Permission model is scattered.** `tool-admission-gates.ts` checks autonomy
   for a few tools; `tool-policy.ts` derives worker `disallowedTools`; but many
   tools have no explicit safety class or audit hook.
3. **No universal choke point.** Audit (`logAudit`) and telemetry are added per
   handler; a new tool can be registered without them.
4. **Caller confusion.** Role-specific servers (`space-agent-tools`, `node-agent`,
   task-agent) expose overlapping names with different schemas, and there is no
   uniform entry point like `call_action`.
5. **No staged rollout.** Switching the entire typed surface is all-or-nothing;
   there is no flag-gated coexistence path.

## Decision

### Core principle

**One MCP tool `call_action(name, params)` on a new `space-actions` server,
dispatching to an authored action registry that wraps the existing typed
handlers.** The dispatcher is the only entry point for Space operations; it is a
strongly-typed in-process dispatch, not a generic remote-procedure gateway.

1. **Choke point.** Each call passes through a single `dispatchAction` pipeline.
   Permission, safety, autonomy, audit, and telemetry run exactly once per call,
   not per handler.
2. **Safety classes.** Each action is classified `read`, `mutate`, `destructive`,
   or `human_only`. Default-deny applies to any unclassified `mutate`; `read`
   actions are always advertised; `destructive` and `human_only` require explicit
   role and autonomy clearance. The class is registry metadata, not prompt
   guidance.
3. **Autonomy through tool-admission gates.** `resolveEffectiveAutonomyLevel` and
   `decideAutonomyAdmission` run at dispatch time. Each action declares a required
   Space autonomy level. Calls below the effective level are rejected with
   `agent_autonomy_ceiling` or `space_autonomy_level` reasons. The
   `getSpaceAutonomyLevel` optional-default-1 semantics are copied exactly: a
   missing level means level 1.
4. **Composed registry.** A single `ActionRegistry` is built from
   `registry-space.ts` (Space operations), `registry-node.ts` (node-agent
   runtime), and role-specific extensions. Filtering is composition: per-node
   `disallowedTools`, worker `toolProfile` denials, and runtime-conditional
   suppression. Conditional entries omit actions whose dependencies are absent
   rather than failing at call time.
5. **Per-role descriptions.** The server generates a 4–6 "hot-action" prose list
   for the calling role; the tail is discoverable through `list_actions` and
   `describe_action`. Do not include the full 293-method census in prompts.
6. **Universal audit + dispatch telemetry.** Every invocation writes an
   `McpAuditLog` row and a dispatch-telemetry row at the choke point. Telemetry
   tracks dispatched-vs-typed diff, latency, and outcome; the soak exit criterion
   is "telemetry dispatched-vs-typed diff is zero".
7. **No MessageHub RPC routing.** The dispatcher is an in-process MCP tool
   server. It does not call `MessageHub` RPC, loopback, or any transport lacking
   the permission model. The typed method census is for coverage only and does
   not define an RPC surface.
8. **Direct superpipe pipeline per action path.** `dispatchAction` is one
   superpipe pipeline (per ADR 0004) that mixes validation, safety, autonomy,
   handler resolution, execution, audit, and telemetry.
9. **Schema ownership.** Zod schemas move from monolithic handlers into
   `tools/space-agent-tool-schemas.ts` and registry sources so the registry can
   validate `params` and generate `describe_action` output. Tool names are stable
   slugs.
10. **Coexistence rollout.** `HYPERNEO_SPACE_ACTIONS_DISPATCHER` gates the server.
    Initial default off (additive dead code); wires attach it alongside existing
    servers (invariants unchanged); prompts prefer `call_action` with a typed
    fallback; default flips to ON for a soak window; CD 17 removes the typed
    surface and flips `requiredServers` invariants to `space-actions`.

### Module layout

| Module | File | Responsibility |
| --- | --- | --- |
| Safety | `packages/daemon/src/lib/space/actions/safety.ts` | Safety classes, default-deny rules |
| Registry | `packages/daemon/src/lib/space/actions/registry.ts` | Core registry, lookup, composition |
| Dispatcher pipeline | `packages/daemon/src/lib/space/actions/dispatcher-pipeline.ts` | `dispatchAction` superpipe |
| Description generator | `packages/daemon/src/lib/space/actions/description-generator.ts` | Per-role hot-action lists |
| Dispatch telemetry | `packages/daemon/src/lib/space/actions/dispatch-telemetry.ts` | Telemetry row writes |
| Space registry | `packages/daemon/src/lib/space/actions/registry-space.ts` | Space/coordinator actions |
| Node registry | `packages/daemon/src/lib/space/actions/registry-node.ts` | Node-agent actions |
| Server | `packages/daemon/src/lib/space/actions/space-actions-server.ts` | MCP server and `call_action` tool |
| Schemas | `packages/daemon/src/lib/space/tools/space-agent-tool-schemas.ts` | Extracted Zod schemas |

## Where the dispatcher must not be used

- **As a generic RPC or MessageHub loopback.** The permission model and audit
  choke point live in the MCP tool server; transport loopback would bypass them.
- **As a state machine or long-running process.** A dispatch is one call;
  lifecycle (runs, tasks, goals) belongs to the runtime.
- **As an owner of atomicity.** Handlers write through repository primitives
  (CAS, transition tables); the dispatcher does not wrap transactions.
- **On hot inner loops.** Dispatch overhead is higher than direct handler calls;
  per-token or per-event tight loops call handlers directly.
- **Before safety class, autonomy level, and audit are defined.** Default-deny on
  unclassified mutations means an action may not be advertised until its metadata
  is complete.
- **To bypass per-node `disallowedTools` or worker `toolProfile`.** Filtering moves
  into registry composition; it is not removed.

## Pattern taxonomy (vocabulary, not categories to choose between)

| Pattern | Shape |
| --- | --- |
| A1 uniform dispatch | `call_action(name, params)` → registry lookup |
| A2 safety gate | `!class`/`!level` halts with deny reason |
| A3 conditional entry | dependency present → advertise; absent → suppress |
| A4 per-role view | registry filtered by role + disallowed list |
| A5 hot-action description | 4–6 prose entries + `list_actions`/`describe_action` tail |
| A6 audit sandwich | audit start → execute → audit/telemetry end |
| A7 superpipe dispatch | one direct pipeline per action path (ADR 0004) |

## Roadmap (open items)

The epic #3129 tracks the work as CD 00–CD 17 slices. This ADR is CD 00.

- CD 00 — ADR 0005 doc (this document)
- CD 01 — pins: autonomy deny strings, `logAudit` rows, `routeApproveTask` gaps
- CD 02–04 — extract Zod schemas (base; agents/goals/Forge; scheduled/ext/inactivity)
- CD 05 — `safety.ts` + `registry.ts`
- CD 06 — `dispatcher-pipeline.ts`
- CD 07 — `description-generator.ts`
- CD 08–10 — `registry-space` A/B/C + telemetry + rate gate
- CD 11 — `registry-node` (including `approve_task` precedence for worker roles)
- CD 12 — `space-actions-server.ts` + `call_action` (additive dead code)
- CD 13–14 — wire attach sites (flag, default off; invariants unchanged)
- CD 15 — prompts prefer `call_action` with fallback
- CD 16 — flag default ON → soak window
- CD 17 — flip `requiredServers` invariants to `space-actions`; delete typed surface

## References

- Epic #3129, issue #3130
- ADR 0004: `docs/adr/0004-superpipe-pipelines.md`
- Typed surface: `packages/daemon/src/lib/space/tools/space-agent-tools.ts`,
  `packages/daemon/src/lib/space/tools/node-agent-tools.ts`,
  `packages/daemon/src/lib/space/tools/task-agent-tool-schemas.ts`
- Admission gates: `packages/daemon/src/lib/space/tools/tool-admission-gates.ts`
- Worker tool policy: `packages/daemon/src/lib/space/agents/tool-policy.ts`
- MCP attach sites: `packages/daemon/src/lib/space/runtime/space-runtime-service.ts`
