# M0 Current-State Inventory

This inventory is the baseline for the architecture refactor. It is intentionally descriptive: no runtime behavior changes belong in M0.

Generated/checked on 2026-06-15 from branch `codex/architecture-refactor-specs`.

## Legacy RPC And MessageHub Surface

Current daemon RPC registration is centered on `setupRPCHandlers` and direct `messageHub.onRequest(...)` calls. Unique literal request names found under `packages/daemon/src`: 278. This count excludes dynamic registration and state-channel constants.

Primary compatibility groups:

| Prefix | Count | Main owner |
| --- | ---: | --- |
| `session.*` | 30 | `packages/daemon/src/lib/rpc-handlers/session-handlers.ts` |
| `evolution.*` | 26 | Forge/evolution handlers |
| `config.*` | 24 | `config-handlers.ts` |
| `space.*` | 20 | `space-handlers`, `space-mcp-handlers`, task-message handlers, GitHub extension |
| `spaceWorkflowRun.*` | 18 | `space-workflow-run-handlers.ts` |
| `mcp.*` | 13 | app/space/global MCP handlers |
| `spaceLongHorizonAgent.*` | 12 | long-horizon agent handlers |
| `spaceAgent.*` | 10 | `space-agent-handlers.ts` |
| `spaceWorkflow.*` | 10 | `space-workflow-handlers.ts` |
| `providers.*` | 8 | provider handlers |
| `settings.*` | 8 | settings handlers |
| `spaceTask.*` | 8 | `space-task-handlers.ts` |
| `spaceGoal.*` | 8 | `space-goal-handlers.ts` |
| `skill.*` | 7 | skills handlers |
| `taskSchedule.*` | 7 | `task-schedule-handlers.ts` |
| `liveQuery.*` | 2 | `live-query-handlers.ts` |

First vertical slice alias inventory:

| Legacy RPC | Target fabric name | Notes |
| --- | --- | --- |
| `spaceTask.create` | `space.task.create` | Preferred M4 slice. Old request and response shape must remain stable. |
| `spaceTask.list` | `space.task.list` | Query/read-model candidate after create path proves bridge. |
| `spaceTask.get` | `space.task.get` | Query/read-model candidate. |
| `spaceTask.update` | `space.task.update` | Command candidate after UoW-safe repository mode lands. |
| `spaceTask.recoverWorkflow` | `space.task.recoverWorkflow` | Runtime-owned; defer until Space Runtime facade exists. |
| `spaceTask.submitForReview` | `space.task.submitForReview` | Workflow/gate behavior; defer until UoW and runtime owner are clear. |
| `spaceTask.approvePendingCompletion` | `space.task.approvePendingCompletion` | Gate/post-approval behavior; defer until runtime owner is clear. |
| `spaceTask.publish` | `space.task.publish` | External/user-visible side effect; migrate after first durable slice. |

Other high-priority families for M2.4 generated aliases:

- `spaceGoal.create`, `spaceGoal.list`, `spaceGoal.get`, `spaceGoal.update`, `spaceGoal.pause`, `spaceGoal.resume`, `spaceGoal.createImmediateTask`, `spaceGoal.listEvents`
- `taskSchedule.create`, `taskSchedule.list`, `taskSchedule.get`, `taskSchedule.update`, `taskSchedule.pause`, `taskSchedule.resume`, `taskSchedule.delete`
- `spaceWorkflowRun.start`, `list`, `get`, `resume`, `markFailed`, `cancel`, `approveGate`, `writeGateData`, `listGateData`, artifact/diff/commit queries
- `space.task.sendMessage` and `space.task.activateNodeAgent` already use dotted `space.task.*` names but are still MessageHub RPCs, not MessageFabric contracts.
- `liveQuery.subscribe` and `liveQuery.unsubscribe` should become compatibility calls over the read-model subscription interface, not a second semantic query protocol.

Migration blockers:

- `setupRPCHandlers` has broad service dependencies and constructs `SpaceRuntimeService` inside the handler setup path.
- State projection registers snapshot requests through constants in `STATE_CHANNELS`; those need explicit classification as read-model queries before cleanup.
- External event extensions can register request handlers dynamically through the extension manager.

## Shared Package Imports

Current root `@neokai/shared` imports dominate package boundaries.

| Import style | Count |
| --- | ---: |
| Root `@neokai/shared` literal specs | 935 |
| Files with at least one root literal | 628 |
| `@neokai/shared/sdk*` literal specs | 100 |
| `@neokai/shared/provider*` literal specs | 45 |
| `@neokai/shared/types*` import specs | 15 |
| `@neokai/shared/message-hub*` literal specs | 7 |

Root literals by package:

| Package | Count |
| --- | ---: |
| `packages/daemon` | 592 |
| `packages/web` | 338 |
| `packages/cli` | 4 |
| `packages/e2e` | 1 |

Current `packages/shared/package.json` exports are root, selected `types`, selected `provider`, selected `message-hub`, and wildcard `sdk`. Before migrating callers, M1 must make export-map parity explicit and add subpath skeletons for `contracts`, `read-models`, `domain`, `messaging`, and `compat`.

Migration blockers:

- Root `mod.ts`, `types.ts`, `api.ts`, and `types/space.ts` are oversized and mix domain types, transport/API shapes, UI-facing read models, and compatibility types.
- `ClientEventGateway` lives under `message-hub`; ownership must be classified before MessageHub cleanup.
- New architecture code must avoid increasing root imports in migrated slices.

## UI Ownership

Current UI ownership is split across `packages/web` and `packages/ui`.

| Area | Current owner | Refactor rule |
| --- | --- | --- |
| Product screens, Space, session, settings, SDK message rendering | `packages/web` | Keep product-specific behavior here until explicit extraction. |
| Existing generic web controls | `packages/web/src/components/ui` | Compatibility facade during migration; do not churn visual styling broadly. |
| Headless/slot primitives and demos | `packages/ui` | Not yet the visual authority for NeoKai product surfaces. |
| SDK tool cards/renderers | `packages/web/src/components/sdk/tools` | Protected renderer island; do not rebuild from `packages/ui` in broad migration. |

Protected SDK renderer island:

- `ToolResultCard.tsx`
- `ToolProgressCard.tsx`
- `tool-registry.ts`
- `ToolIcon.tsx`
- `ToolSummary.tsx`
- `DiffViewer.tsx`
- `CodeViewer.tsx`
- `TodoViewer.tsx`
- `AuthStatusCard.tsx`
- `tool-utils.ts`
- `sdk-tool-types.ts`
- `tool-types.ts`

Migration blockers:

- `ToolResultCard.tsx` is currently 600 lines and allowlisted only because it is protected behavior. The UI migration must preserve its current visual and behavioral contract unless a dedicated SDK renderer redesign PR is approved.
- `packages/ui` exports controls like `Button`, `Dialog`, `Menu`, `Popover`, `Tabs`, `Toast`, and `Tooltip`, but it does not currently own NeoKai's dense dark product look.
- First UI PRs need screenshot parity before/after. No read-model migration should be combined with visual migration in the first PR.

## Runtime And Storage Owners

Space runtime current owners:

| Concern | Current owner |
| --- | --- |
| Top-level runtime orchestration | `packages/daemon/src/lib/space/runtime/space-runtime.ts` |
| Runtime service construction/startup/recovery | `space-runtime-service.ts` |
| Task and node agent sessions | `task-agent-manager.ts` |
| Channel routing | `channel-router.ts` and `agent-message-router.ts` |
| Gate polling/evaluation | `gate-poll-manager.ts`, `gate-evaluator.ts`, workflow/gate helpers |
| Task persistence coordination | `space-task-manager.ts` and `space-task-repository.ts` |
| Built-in workflow templates | `built-in-workflows.ts` |

Storage current owners:

| Concern | Current owner |
| --- | --- |
| Database facade and repository construction | `packages/daemon/src/storage/index.ts` |
| Reactive invalidation | `reactive-database.ts` |
| SQL live subscriptions | `live-query.ts` and `live-query-handlers.ts` |
| Schema migrations | `storage/schema/migrations.ts` and `storage/schema/index.ts` |
| Space task writes | `space-task-repository.ts`, `space-task-manager.ts` |
| Goal/task/job/MCP/skill writes | repository classes under `storage/repositories` |

Migration blockers:

- Repositories currently receive raw `BunDatabase`; some also receive `ReactiveDatabase` and call notification paths directly.
- UoW-bound repository mode must prevent direct `reactiveDb.notifyChange`, event publish, and independent write transactions.
- Live-query invalidation must move behind after-commit/change-recording behavior before write commands switch to UoW.
- `SpaceRuntimeService` and `TaskAgentManager` are oversized and have many startup/session/runtime responsibilities; M9 extraction should create facade seams before moving behavior.
