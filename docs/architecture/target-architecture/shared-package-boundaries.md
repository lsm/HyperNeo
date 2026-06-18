# Shared Package Boundaries Design

**Date:** 2026-05-21
**Status:** Draft Design
**Related:**
- [Unified Message Fabric Architecture Design](./unified-message-fabric-design.md)
- [Space Runtime Decomposition Design](./space-runtime-decomposition.md)
- [Client State And Read Models Design](./client-state-and-read-models.md)

---

## 1. Overview

`@neokai/shared` currently works as a global barrel for almost every cross-package concept: API request/response types, domain types, MessageHub runtime classes, provider contracts, SDK aliases, state-channel types, prompt templates, logger utilities, validators, Space workflow graph helpers, and Forge evolution types.

That made early development fast, but it now hides architectural boundaries. Daemon code, web code, CLI code, and UI components can import almost anything from one package root. As MessageFabric, Space runtime decomposition, client read models, and Forge mature, the shared package needs explicit contract surfaces.

This document defines target package boundaries and an incremental migration plan. The goal is not to create many packages immediately. The first step can be subpath exports inside `@neokai/shared`. The important change is that imports reveal ownership and stability.

---

## 2. Current State

`packages/shared/src/mod.ts` exports broad surfaces:

- `types.ts`
- `api.ts`
- MessageHub classes, router, protocol, transports, typed hub, channels, and client gateway
- `utils.ts`
- `state-types.ts`
- `models.ts`
- settings, endpoints, rewind, GitHub, Space, actor projection, Forge evolution, tools, MCP, skills, reference, live query, validators, workflow graph, prompts
- logger

Large files carry mixed responsibilities:

| File | Current role |
| --- | --- |
| `types.ts` | Sessions, providers, thinking settings, tools config, message content, auth, context, file tree, commands, health, and miscellaneous API-facing types. |
| `types/space.ts` | Space metadata, goals, schedules, tasks, activity, node executions, workflow runs, agents, gates, channels, workflows, export/import types, artifacts, approvals, runtime activity. |
| `types/evolution.ts` | Forge scopes, evidence, metric snapshots, episodes, lessons, task proposals, and related params. |
| `api.ts` | Request/response shapes for sessions, workspace, git, messages, files, config, MCP, Forge evolution, provider, SDK cleanup, registry, and skills. |
| `message-hub/*` | Protocol types plus concrete runtime/router/transport implementations. |
| `state-types.ts` | Legacy state-channel snapshot/update types mixed with current client state shapes. |

The package export map already supports a few subpaths (`./provider`, `./message-hub/*`, `./sdk/*`, `./types/*`), but most app code still imports from `@neokai/shared` directly.

At the time of this review, direct root imports are substantially more common than subpath imports in the main packages. The root barrel is therefore the effective public API.

---

## 3. Problems

1. **Boundary leakage:** client and daemon code can import implementation-oriented classes such as `MessageHubRouter` from the same place as stable domain types.
2. **Unclear stability:** a type exported from the root barrel looks public even when it is daemon-only, compatibility-only, or transitional.
3. **Unnecessary rebuild blast radius:** changing a large type file can invalidate unrelated consumers.
4. **Name collisions and semantic drift:** `api.ts`, `types.ts`, `state-types.ts`, Space domain types, and read-model types all compete for root namespace.
5. **Transport/runtime coupling:** protocol envelopes, router internals, WebSocket transports, and in-process transports are exported together.
6. **Frontend dependency weight:** web components can accidentally depend on daemon/runtime concepts through the broad barrel.
7. **Forge growth pressure:** Forge evolution types are new and likely to grow into commands, queries, events, read models, and agent-facing tools. Keeping them as one domain file plus `api.ts` request wrappers will repeat the current Space type sprawl.

---

## 4. Design Goals

1. **Explicit import surfaces:** imports should say whether code is using contracts, read models, domain types, transport internals, SDK aliases, provider contracts, or utilities.
2. **Stable contract layer:** MessageFabric command/query/event contracts are the primary cross-boundary API.
3. **UI-safe read models:** web code imports read models and client contracts without seeing daemon-only implementation types.
4. **Daemon implementation privacy:** repositories, managers, runtime helpers, MessageHub internals, and transport implementations are not exposed through root shared exports.
5. **Incremental migration:** keep root exports temporarily, but mark them compatibility-only and move consumers one area at a time.
6. **Forge first-class namespace:** Forge gets the same contract/read-model/domain split as Space.
7. **Type-only sharing first:** shared should mostly contain serializable contracts, schemas, and pure helpers.

## 5. Non-Goals

- Splitting the monorepo into many npm packages immediately.
- Rewriting all imports in one patch.
- Removing compatibility MessageHub exports before MessageFabric migration is complete.
- Moving upstream SDK `.d.ts` files out of the repo.
- Blocking daemon tests from importing broad types during the migration.

---

## 6. Target Export Surfaces

The target can be implemented as subpath exports inside `@neokai/shared` first.

```json
{
  "exports": {
    ".": "./src/compat/root.ts",
    "./contracts": "./src/contracts/index.ts",
    "./contracts/*": "./src/contracts/*.ts",
    "./read-models": "./src/read-models/index.ts",
    "./read-models/*": "./src/read-models/*.ts",
    "./domain/space": "./src/domain/space/index.ts",
    "./domain/forge": "./src/domain/forge/index.ts",
    "./domain/session": "./src/domain/session/index.ts",
    "./domain/settings": "./src/domain/settings/index.ts",
    "./domain/config": "./src/domain/config/index.ts",
    "./domain/extensions": "./src/domain/extensions/index.ts",
    "./domain/prompt-policy": "./src/domain/prompt-policy/index.ts",
    "./domain/agent-runtime": "./src/domain/agent-runtime/index.ts",
    "./types": "./src/types.ts",
    "./types/*": "./src/types/*.ts",
    "./state-types": "./src/state-types.ts",
    "./models": "./src/models.ts",
    "./provider": "./src/provider/index.ts",
    "./provider/*": "./src/provider/*.ts",
    "./sdk": "./src/sdk/index.ts",
    "./sdk/*": "./src/sdk/*",
    "./acp": "./src/acp/index.ts",
    "./acp/*": "./src/acp/*.ts",
    "./messaging/protocol": "./src/messaging/protocol.ts",
    "./messaging/client": "./src/messaging/client.ts",
    "./messaging/testing": "./src/messaging/testing.ts",
    "./message-hub/protocol": "./src/message-hub/protocol.ts",
    "./message-hub/types": "./src/message-hub/types.ts",
    "./message-hub/message-hub": "./src/message-hub/message-hub.ts",
    "./compat/message-hub/*": "./src/message-hub/*.ts",
    "./utils": "./src/utils/index.ts",
    "./logger": "./src/logger.ts"
  }
}
```

M1 must preserve the existing public subpaths while adding target subpaths. The legacy `./types`,
`./types/*`, `./state-types`, `./models`, `./provider/*`, `./sdk`, `./sdk/*`, `./acp`, `./acp/*`,
and `./message-hub/*` exports stay as compatibility aliases until every daemon and web import has
moved to the narrower domain, contract, read-model, provider, runtime, or messaging subpath.

Root import remains during migration but should not be used by new code.

---

## 7. Boundary Definitions

### 7.1 Contracts

Contracts are the stable cross-boundary API. They define command, query, event, and result shapes.

Target path:

```text
@neokai/shared/contracts
@neokai/shared/contracts/space
@neokai/shared/contracts/forge
@neokai/shared/contracts/session
@neokai/shared/contracts/config
@neokai/shared/contracts/extensions
@neokai/shared/contracts/prompt-policy
@neokai/shared/contracts/provider
@neokai/shared/contracts/settings
```

Rules:

- Contracts are serializable.
- Contracts include message names, versions, request payloads, result payloads, event payloads, and auth/durability metadata where useful.
- Contracts may reference domain IDs and read models.
- Contracts do not import daemon repositories, managers, SDK implementation classes, UI component props, MessageHub router classes, or transport implementations.

Example:

```typescript
export interface CommandContract<TInput, TResult> {
  kind: 'command';
  name: string;
  version: number;
  input: TInput;
  result: TResult;
}
```

Forge examples:

- `forge.scope.create`
- `forge.scope.list`
- `forge.scope.detail`
- `forge.evidence.created`
- `forge.rollup.applied`

Space runtime examples:

- `space.workflowRun.start`
- `space.workflowNode.activate`
- `space.workflowGate.dataChanged`
- `space.workflowRun.completed`

### 7.2 Read Models

Read models are UI/client-facing projections. They are not necessarily database rows.

Target path:

```text
@neokai/shared/read-models
@neokai/shared/read-models/space
@neokai/shared/read-models/forge
@neokai/shared/read-models/session
@neokai/shared/read-models/config
@neokai/shared/read-models/extensions
@neokai/shared/read-models/prompt-policy
```

Rules:

- Read models are stable enough for clients.
- They may denormalize related domain objects.
- They should avoid exposing write-only or daemon-internal fields.
- They should include version/cursor metadata when used for live subscriptions.

Examples:

- `SpaceListItemReadModel`
- `SpaceTaskBoardReadModel`
- `WorkflowRunRuntimeReadModel`
- `ForgeScopeReadModel`
- `ForgeScopeDetailReadModel`
- `SessionListItemReadModel`

Forge read models should include linked-goal summary, evidence counts, active lesson counts, proposed task counts, latest episode, and rollup state where needed by the Forge UI.

### 7.3 Domain Types

Domain types are canonical business entities, often close to persistence but still serializable.

Target paths:

```text
@neokai/shared/domain/space
@neokai/shared/domain/forge
@neokai/shared/domain/session
@neokai/shared/domain/settings
@neokai/shared/domain/config
@neokai/shared/domain/extensions
@neokai/shared/domain/prompt-policy
```

Rules:

- Domain types can be shared when both daemon and client need the same durable entity shape.
- They should not contain repository-only params such as internal create/update helpers unless the caller boundary truly needs them.
- Internal daemon-only params should move out of shared or to an explicit internal subpath.

Current candidates:

| Current type family | Target |
| --- | --- |
| `Space`, `SpaceTask`, `SpaceWorkflowRun`, `NodeExecution` | `domain/space` |
| `SpaceWorkflow`, `Gate`, `WorkflowChannel`, `WorkflowNode` | `domain/space/workflow` |
| `SpaceGoal`, `TaskSchedule` | `domain/space/mission` |
| `EvolutionScope`, `EvidenceRef`, `EvolutionEpisode`, `EvolutionLesson`, `TaskProposal`, `MetricSnapshot` | `domain/forge` |
| `Session`, `SessionContext`, `SessionFeatures` | `domain/session` |
| settings types | `domain/settings` |
| config key definitions, scopes, source chains | `domain/config` |
| extension package and contribution types | `domain/extensions` |
| `PromptPolicyRecord`, prompt policy scope/source/channel types | `domain/prompt-policy` |

### 7.4 Messaging

Messaging exports should distinguish stable protocol from compatibility implementation.

Target paths:

```text
@neokai/shared/messaging/protocol
@neokai/shared/messaging/client
@neokai/shared/messaging/testing
@neokai/shared/compat/message-hub/*
```

Rules:

- `messaging/protocol` exports serializable envelope/protocol types only.
- `messaging/client` exports browser-safe client helpers.
- MessageHub router, server transports, in-process transport, and typed hub compatibility live under `compat/message-hub`.
- Daemon code can use compatibility internals during migration.
- Web components should not import server/router/transport internals.

### 7.5 Provider Contracts

Provider contracts are already partly isolated under `@neokai/shared/provider`.

Rules:

- Keep provider auth/model/list contracts separate from session and settings domains.
- Provider runtime implementations remain daemon-only.
- Bridge-provider implementation details should not leak into root shared types.

### 7.6 SDK Types

SDK `.d.ts` files remain available through `@neokai/shared/sdk/*`.

Rules:

- SDK aliases should be imported from explicit SDK subpaths.
- Root shared should not re-export all SDK surface.
- Type guards may stay in `@neokai/shared/sdk/type-guards` if they are pure and used by both daemon and web.

### 7.7 Utilities And Logger

Utilities should be small and explicit.

Target paths:

```text
@neokai/shared/utils
@neokai/shared/logger
@neokai/shared/validation/workspace-path
```

Rules:

- Pure serializable helpers can remain shared.
- Daemon-only helpers move to daemon.
- Browser-only helpers move to web.
- `generateUUID`, JSON parsing helpers, and validators can stay if they are environment-neutral.

### 7.8 Prompts

Prompt templates are not general shared contracts.

Rules:

- Agent/system prompts should not be root exports.
- If daemon owns prompt assembly, prompt templates should move to daemon or a daemon-facing subpath.
- If prompts are user-visible templates, expose them through a clear product/template namespace.

### 7.9 Prompt Policy

Prompt policy types are shared contracts and domain/read-model shapes, but prompt policy resolution and rendering are daemon-side Agent Runtime behavior.

Target paths:

```text
@neokai/shared/domain/prompt-policy
@neokai/shared/contracts/prompt-policy
@neokai/shared/read-models/prompt-policy
```

Rules:

- `domain/prompt-policy` owns serializable row/domain types such as `PromptPolicyRecord`, `PromptPolicyScope`, `PromptPolicySource`, and channel names.
- `contracts/prompt-policy` owns command/query/event payloads such as `promptPolicy.builtin.activate`, `promptPolicy.record.update`, and `promptPolicy.effective.preview`.
- `read-models/prompt-policy` owns preview results: applied records, suppressed records, active built-ins, inherited source, and channel previews.
- `PromptPolicyResolver`, `PromptPolicyComposer`, `PromptPolicyRenderer`, and built-in prompt text live in daemon Agent Runtime code, not shared.
- Prompt policy is not the same as user-visible prompt templates. Shared policy types describe durable records and read models; rendered prompt fragments are daemon behavior.

### 7.10 Config And Extensions

Configuration and extension types describe effective settings, source chains, package metadata, and semantic contributions. They do not describe SDK-specific plugin loader internals.

Target paths:

```text
@neokai/shared/domain/config
@neokai/shared/contracts/config
@neokai/shared/read-models/config
@neokai/shared/domain/extensions
@neokai/shared/contracts/extensions
@neokai/shared/read-models/extensions
```

Rules:

- `domain/config` owns serializable config key definitions, scope names, source-chain entries, merge strategy names, and redaction metadata.
- `read-models/config` owns effective value preview shapes, including current value, inherited value, source, allowed scopes, and reset/override actions.
- `domain/extensions` owns extension package metadata and contribution types such as `skill.command`, `tool.mcp`, `hook.policy`, `prompt.policy`, and `runtime.setting`.
- `read-models/extensions` owns active contribution previews with package source, trust level, render target, and suppress/override source.
- Runtime-specific plugin manifests, hook callback implementations, MCP server processes, and prompt rendering stay daemon-side or runtime-adapter-side.
- A Markdown file or local plugin path is not a shared semantic type by itself; it becomes shared only through a declared skill, prompt policy, hook policy, MCP, or runtime setting contribution.

---

## 8. File Organization Target

Suggested internal structure:

```text
packages/shared/src/
  compat/
    root.ts
    message-hub/
  contracts/
    index.ts
    fabric.ts
    space.ts
    forge.ts
    session.ts
    provider.ts
    settings.ts
    config.ts
    extensions.ts
    prompt-policy.ts
  read-models/
    index.ts
    space.ts
    forge.ts
    session.ts
    config.ts
    extensions.ts
    prompt-policy.ts
  domain/
    space/
      index.ts
      task.ts
      workflow.ts
      goal.ts
      schedule.ts
      runtime.ts
    forge/
      index.ts
      scope.ts
      evidence.ts
      episode.ts
      lesson.ts
      proposal.ts
      metrics.ts
    session/
      index.ts
    settings/
      index.ts
    config/
      index.ts
    extensions/
      index.ts
    prompt-policy/
      index.ts
  messaging/
    protocol.ts
    client.ts
    testing.ts
  provider/
  sdk/
  utils/
  validation/
  logger.ts
```

This does not need to be one patch. The first step can create new files that re-export current types from old files, then gradually move definitions.

---

## 9. Root Barrel Policy

Root import should become compatibility-only:

```typescript
// Allowed temporarily.
import type { SpaceTask } from '@neokai/shared';

// Target.
import type { SpaceTask } from '@neokai/shared/domain/space';
import type { SpaceTaskUpdatedEvent } from '@neokai/shared/contracts/space';
import type { SpaceTaskBoardReadModel } from '@neokai/shared/read-models/space';
```

Policy:

1. New code must use subpath imports.
2. Root imports remain for compatibility until migrated.
3. A lint/check rule should fail new root imports outside an allowlist.
4. The allowlist shrinks by package and directory.
5. Root export file eventually becomes tiny or is removed in a major internal migration.

Suggested check:

```text
No new `from '@neokai/shared'` imports except in files listed in tools/shared-root-import-allowlist.json.
```

---

## 10. Contract Naming

Contracts should align with MessageFabric names.

Examples:

```typescript
export namespace SpaceTaskContracts {
  export const Create = 'space.task.create';
  export const Updated = 'space.task.updated';
}

export namespace ForgeContracts {
  export const ScopeList = 'forge.scope.list';
  export const ScopeCreated = 'forge.scope.created';
  export const RollupApplied = 'forge.rollup.applied';
}
```

Rules:

- Use dot-separated contract names.
- Put legacy RPC names in compatibility adapters, not new contract modules.
- Preserve old `evolution.*` names only in compatibility bridges; target Forge contract names use `forge.*`.
- Include contract version where payload stability matters.

---

## 11. Forge Boundary

Forge should not be just another section in `api.ts`.

Target split:

| Surface | Contents |
| --- | --- |
| `domain/forge` | `EvolutionScope`, `EvidenceRef`, `MetricSnapshot`, `EvolutionEpisode`, `EvolutionLesson`, `TaskProposal`. |
| `contracts/forge` | Forge commands, queries, events, request/result payloads. |
| `read-models/forge` | `ForgeScopeReadModel`, `ForgeScopeDetailReadModel`, timeline entries, review bundle read models. |
| daemon-only | judge prompt input/output, episode generation internals, repository params, service dependency types. |
| web-only | Forge tab state, dialog drafts, selected evidence IDs, optimistic form errors. |
| agent-tool contracts | MCP tool arg/result schemas if they must be shared with generated docs or tests. |

Cross-domain references:

- Forge domain may reference Space IDs, task IDs, workflow run IDs, and goal IDs by string.
- Forge read models may embed `SpaceGoal` summaries or use a `LinkedGoalSummary` read model.
- Forge contracts may return `SpaceTask` or `SpaceGoal` only for commands whose effect crosses domains, such as proposal-to-task and rollup.

Events:

- `forge.rollup.applied` is a Forge event.
- `space.goal.updated` remains the Space goal event caused by the same command.
- `forge.taskProposal.updated` is a Forge event.
- `space.task.created` remains the Space task event caused by proposal conversion.

---

## 12. Space Boundary

`types/space.ts` should be split because it currently mixes several layers.

Target modules:

| Module | Types |
| --- | --- |
| `domain/space/core` | `Space`, config, autonomy level, runtime state. |
| `domain/space/task` | `SpaceTask`, task params, activity member, statuses, priorities. |
| `domain/space/goal` | `SpaceGoal`, goal events, mission status/type. |
| `domain/space/schedule` | `TaskSchedule`, schedule status/trigger. |
| `domain/space/workflow` | `SpaceWorkflow`, nodes, channels, gates, workflow summaries. |
| `domain/space/runtime` | `SpaceWorkflowRun`, `NodeExecution`, artifacts, approvals. |
| `domain/space/export` | export/import bundle shapes. |
| `read-models/space` | board summaries, sidebar summaries, runtime canvas read models. |
| `contracts/space` | commands, queries, events for all Space domains. |

Daemon-only types such as `InternalCreateSpaceTaskParams` and `InternalUpdateSpaceTaskParams` should move to daemon or an explicit internal subpath.

---

## 13. API Types Boundary

`api.ts` should stop being the kitchen-sink API surface.

Target split:

| Current section | Target |
| --- | --- |
| session/workspace/git/message/file requests | `contracts/session`, `contracts/workspace`, `contracts/git`, `contracts/files` |
| config/settings requests | `contracts/settings` |
| effective config and source-chain preview requests | `contracts/config` |
| extension package/contribution requests | `contracts/extensions` |
| MCP registry requests | `contracts/mcp` |
| Forge evolution requests | `contracts/forge` |
| prompt policy requests | `contracts/prompt-policy` |
| provider requests | `contracts/provider` |
| skill requests | `contracts/skills` |

MessageFabric contracts should replace ad hoc request/response names over time. Legacy RPC wrappers can re-export old names from compatibility modules during migration.

---

## 14. Dependency Rules

Allowed dependencies:

```text
contracts -> domain, read-models, messaging/protocol
read-models -> domain
domain -> pure utilities only
contracts/prompt-policy -> domain/prompt-policy, read-models/prompt-policy
read-models/prompt-policy -> domain/prompt-policy
contracts/config -> domain/config, read-models/config
read-models/config -> domain/config
contracts/extensions -> domain/extensions, read-models/extensions
read-models/extensions -> domain/extensions
messaging/protocol -> pure utilities only
messaging/client -> messaging/protocol
provider -> models, pure utilities
sdk -> upstream SDK declarations
compat -> anything required for old imports
```

Disallowed dependencies:

```text
domain -> contracts
domain -> read-models
domain -> message-hub runtime classes
read-models -> message-hub runtime classes
contracts -> message-hub router/transports
web -> compat/message-hub server/router internals
ui -> daemon-only or transport internals
shared root -> new source files
```

---

## 15. Migration Plan

### Phase 0: Add Subpath Skeletons

- Add `contracts`, `read-models`, `domain`, `messaging`, and `compat` directories.
- Re-export existing types from the new subpaths without moving definitions.
- Update `package.json` exports.
- Add docs explaining import policy.

### Phase 1: Move New Code To Subpaths

- Require new docs/spec implementation work to import from subpaths.
- Add a check that prevents new root imports outside an allowlist.
- Keep `mod.ts` unchanged for existing consumers.

### Phase 2: Forge First

- Move Forge definitions from `types/evolution.ts` and `api.ts` behind:
  - `domain/forge`
  - `contracts/forge`
  - `read-models/forge`
- Keep old exports as re-exports.
- Update `SpaceForge`, evolution handlers, and Forge services to use subpaths.

Forge is a good first slice because it is new, comparatively contained, and already needs clean client read-model boundaries.

### Phase 3: MessageFabric Contracts

- Add `contracts/fabric`.
- Move command/query/event envelope types there.
- Move MessageHub runtime implementation to `compat/message-hub`.
- Update daemon and web code to import protocol/client types from `messaging/*`.
- Add package export-map parity before caller migration: every currently used public subpath is either exported, marked internal, or covered by an explicit compatibility alias.

### Phase 4: Prompt Policy Boundaries

- Add `domain/prompt-policy`, `contracts/prompt-policy`, and `read-models/prompt-policy`.
- Keep resolver/composer/renderer and built-in prompt text in daemon Agent Runtime code.
- Update token-efficiency/output-mode work to use prompt-policy subpaths instead of settings/session-specific fields.

### Phase 5: Config And Extension Boundaries

- Add `domain/config`, `contracts/config`, and `read-models/config`.
- Add `domain/extensions`, `contracts/extensions`, and `read-models/extensions`.
- Keep SDK plugin loading, hook callbacks, MCP process lifecycle, and prompt rendering outside shared.
- Update skills/plugins/MCP/settings implementation work to expose effective previews through config/extension subpaths instead of broad settings or skill-specific shapes.

### Phase 6: Space Domain Split

- Split `types/space.ts` into domain modules.
- Add read models from the client-state design.
- Add Space command/query/event contracts.
- Update Space runtime, Space stores, and Space components gradually.

### Phase 7: API Split

- Move `api.ts` sections into contract modules.
- Keep `api.ts` as a compatibility re-export file.
- Make legacy RPC adapters depend on compatibility API names while new MessageFabric handlers use contract modules.

### Phase 8: Root Barrel Reduction

- Create `compat/root.ts` as the named compatibility root barrel and make the public root delegate to it while migration proceeds.
- Track root import count and subpath import count in the migration evidence.
- Replace direct root imports package by package.
- Prefer daemon first for implementation clarity, then web stores/components, then tests.
- Stop exporting MessageHub internals, prompts, and daemon-only params from the root barrel.
- Classify `ClientEventGateway` ownership before moving imports: either `messaging/client` if it survives as transport-neutral client delivery, or `compat/message-hub` if it only exists for legacy MessageHub delivery.

### Phase 9: Enforce Boundaries

- Add lint/import checks:
  - no new root imports;
  - no web imports from `compat/message-hub` server/router internals;
  - no domain imports from contracts/read-models;
  - no contracts importing runtime classes.
- Add package-boundary tests if necessary.

---

## 16. Suggested First Implementation Slice

Start with Forge and contracts because it aligns with the newest work.

1. Create `domain/forge/index.ts` that re-exports from `types/evolution.ts`.
2. Create `contracts/forge.ts` with Forge command/query/event payload names.
3. Create `read-models/forge.ts` with `ForgeScopeReadModel`, `ForgeScopeDetailReadModel`, and timeline types from the client-state spec.
4. Update `package.json` exports for those subpaths.
5. Verify package export-map parity so no exported path points to a missing file.
6. Update `SpaceForge.tsx`, `evolution-handlers.ts`, `evolution-scope-service.ts`, and `evolution-episode-service.ts` imports where low-risk.
7. Keep `@neokai/shared` root exports in place through `compat/root.ts`.
8. Add a check preventing new root imports in newly touched Forge files.

This gives immediate value without forcing a full Space type split.

---

## 17. Design Rules

1. New cross-boundary behavior starts in `contracts/*`.
2. New UI data shapes start in `read-models/*`.
3. Durable business entities live in `domain/*`.
4. Root `@neokai/shared` imports are compatibility-only.
5. MessageHub runtime classes are compatibility internals, not the future public messaging API.
6. Forge must use the same domain/contract/read-model split as Space.
7. Prompt policy shared exports contain serializable records, contracts, and read models only; resolver/composer/renderer stay daemon-side.
8. Config/extension shared exports contain serializable keys, scopes, source chains, packages, contributions, and previews only; SDK plugin loading, hook callbacks, MCP process lifecycle, and prompt rendering stay daemon/runtime-side.
9. Daemon-only params and service dependency types do not belong in shared.
10. New shared source files target 300 lines or less including comments and must stay below 500 lines; large existing shared files should split by domain, contract, read-model, messaging, or compatibility ownership as they migrate.
11. Package exports must match allowed public and compatibility surfaces; exported paths must not point to missing files.
12. Pure utilities are shared only when both daemon and web actually use them.

---

## 18. Open Questions

1. Should subpath boundaries stay inside `@neokai/shared`, or should contracts/read-models become separate workspace packages later?
2. Should Zod or another schema library define contract payloads at runtime, or do we start with TypeScript-only contracts?
3. Should old `evolution.*` RPC names remain indefinitely as compatibility aliases for `forge.*` contracts?
4. How strict should the no-root-import check be for tests during migration?
5. Should prompt templates move to daemon immediately, or stay under a product-template subpath?
