# M1 Shared Boundaries Execution Plan

## Purpose

M1 makes `@neokai/shared` explicit enough that MessageFabric, UoW, config/extensions, Agent Runtime, Space Runtime, and client read-model work can depend on stable subpaths instead of the root barrel.

This milestone is mostly `foundation` phase work. It should not change runtime behavior, WebSocket/RPC behavior, database behavior, or UI visuals.

## Inputs

- [Shared Package Boundaries Design](../shared-package-boundaries.md)
- [M0 Current-State Inventory](03-current-state-inventory.md)
- [Source File Size Ratchet](02-file-size-ratchet.md)

Current facts:

- `@neokai/shared` root literal specs: 941.
- Files with at least one root literal: 626.
- Root literals by package: `packages/daemon` 597, `packages/web` 339, `packages/cli` 4, `packages/e2e` 1.
- Current root barrel: `packages/shared/src/mod.ts`.
- Current oversized shared files: `types/space.ts` 2681 lines, `api.ts` 1242 lines, `types.ts` 982 lines, `message-hub/message-hub.ts` 856 lines.
- Current export map has missing paths for `./message-hub/unix-socket-transport` and `./message-hub/stdio-transport`; no current package imports were found for those paths.

## M1 Exit Criteria

M1 is complete when:

- package export-map parity is checked by a script or targeted test;
- every exported `@neokai/shared` subpath points to an existing file;
- skeleton subpaths exist for `contracts`, `read-models`, `domain`, `messaging`, and `compat`;
- `compat/root.ts` exists as the named legacy root surface;
- root exports remain available for existing consumers;
- Forge has explicit `domain`, `contracts`, and `read-models` subpaths;
- prompt policy, config, and extensions have type-only shared subpath skeletons;
- new architecture code has an advisory or narrow check against adding root imports;
- PR evidence tracks root import count and file-size report output.

## Non-Goals

- Do not rewrite all root imports in one PR.
- Do not split `types/space.ts`, `api.ts`, or `types.ts` by moving definitions yet.
- Do not route any RPC through MessageFabric.
- Do not change MessageHub runtime behavior.
- Do not migrate client stores or UI visuals.
- Do not introduce runtime validation libraries unless a later contract PR explicitly chooses one.

## PR Sequence

### M1.1 Export-Map Parity And Subpath Skeletons

Phase: `foundation`

Scope:

- Add an export-map parity check for `packages/shared/package.json`.
- Fix missing export paths by either removing unused missing exports or adding explicit compatibility files. Based on current search, removing `message-hub/unix-socket-transport` and `message-hub/stdio-transport` is preferred unless a hidden consumer is found.
- Add skeleton directories:
  - `packages/shared/src/contracts`
  - `packages/shared/src/read-models`
  - `packages/shared/src/domain`
  - `packages/shared/src/messaging`
  - `packages/shared/src/compat`
- Add `packages/shared/src/compat/root.ts` as a re-export of the existing root surface.
- Add export map entries for the skeletons without moving definitions.

Release safety:

- Existing root `@neokai/shared` imports still compile.
- New subpaths are additive.
- Removing missing export paths is safe only because the paths currently point to files that do not exist and no repo imports use them.

Likely files:

- `packages/shared/package.json`
- `packages/shared/src/compat/root.ts`
- `packages/shared/src/contracts/index.ts`
- `packages/shared/src/read-models/index.ts`
- `packages/shared/src/domain/index.ts`
- `packages/shared/src/messaging/protocol.ts`
- `scripts/check-shared-exports.ts` or equivalent test
- `package.json` script entry if the check is reusable

Acceptance:

- `bun run check` passes.
- Export-map parity check fails when an export points to a missing file.
- Root import count is unchanged or lower.
- No new source file exceeds 300 lines.
- `bun run architecture:file-size-report -- --changed-from origin/dev` reports no violations.

Rollback:

- Revert the skeleton exports and parity script. Existing root imports keep working because M1.1 must not require caller migration.

### M1.2 Forge Boundary Slice

Phase: `foundation`

Scope:

- Add `domain/forge` re-exports for current Forge/Evolution domain types from `types/evolution.ts`.
- Add `contracts/forge` with target `forge.*` command/query/event names and payload aliases or minimal serializable interfaces.
- Add `read-models/forge` with UI-facing Forge scope/detail/timeline shapes.
- Move a narrow set of Forge imports from the root barrel to the new subpaths.

Release safety:

- Old `evolution.*` RPC names and existing API request/response types remain exported through compatibility paths.
- No storage, handler, or UI behavior changes.
- Import moves should be type-only where possible.

Likely files:

- `packages/shared/src/domain/forge/index.ts`
- `packages/shared/src/contracts/forge.ts`
- `packages/shared/src/read-models/forge.ts`
- `packages/shared/src/contracts/index.ts`
- `packages/shared/src/read-models/index.ts`
- `packages/web/src/components/space/SpaceForge.tsx`
- `packages/daemon/src/lib/space/evolution-scope-service.ts`
- `packages/daemon/src/lib/space/evolution-episode-service.ts`
- low-risk Forge handler/test files if needed

Acceptance:

- Existing Forge UI and daemon tests compile unchanged.
- Touched Forge files do not import Forge types from root `@neokai/shared`.
- Root import count decreases in the touched Forge files.
- No payload rename leaks to public RPC behavior.

Rollback:

- Revert caller import moves and keep the new shared subpaths unused. Because subpaths are additive, rollback does not require runtime changes.

### M1.3 Prompt Policy Shared Types

Phase: `foundation`

Scope:

- Add type-only skeletons for:
  - `domain/prompt-policy`
  - `contracts/prompt-policy`
  - `read-models/prompt-policy`
- Define only serializable record, scope, source, channel, command/query/event, and preview shapes.
- Keep resolver, composer, renderer, and built-in prompt text out of shared.

Release safety:

- New types are unused or preview-only.
- No prompt assembly behavior changes.

Acceptance:

- Types match the prompt policy registry spec vocabulary.
- No daemon runtime implementation imports from shared prompt-policy modules unless it is using serializable contracts or domain/read-model shapes.
- No source file exceeds the line-size target.

Rollback:

- Remove unused type-only modules.

### M1.4 Config And Extension Shared Types

Phase: `foundation`

Scope:

- Add type-only skeletons for:
  - `domain/config`
  - `contracts/config`
  - `read-models/config`
  - `domain/extensions`
  - `contracts/extensions`
  - `read-models/extensions`
- Represent config keys, scopes, source chains, merge strategies, redaction metadata, extension packages, contributions, trust, and effective previews.
- Keep SDK plugin loading, hook callbacks, MCP process lifecycle, and prompt rendering outside shared.

Release safety:

- Existing settings, skills, MCP, and plugin flows remain unchanged.
- New shapes are additive and can be used by preview queries later.

Acceptance:

- Types distinguish native SDK settings from HyperNeo overrides.
- Types distinguish skill commands, MCP tools, hook policies, prompt policies, and runtime settings.
- No type implies that a Markdown/plugin file is active without a declared contribution.

Rollback:

- Remove unused type-only modules.

### M1.5 Import Boundary Inventory And Advisory Checks

Phase: `enforcement`

Scope:

- Add a root-import inventory script or report mode.
- Add an allowlist for current root imports.
- Make the check advisory or narrow to newly touched migrated slices.
- Record root/subpath import counts in PR evidence.

Release safety:

- Do not fail the whole repo for existing root imports.
- Only block new root imports in files or directories explicitly migrated in the same PR.

Acceptance:

- The check can report current root import counts by package.
- The check can fail when a migrated slice adds a new root import.
- Allowlist format is reviewable and can shrink by package/directory.

Rollback:

- Disable the advisory check while keeping inventories and subpaths.

## Dependency Rules During M1

Allowed:

- `contracts -> domain, read-models, messaging/protocol`
- `read-models -> domain`
- `domain -> pure utilities`
- `compat -> old root, old message-hub, old api/types files`
- existing callers -> root shared until migrated

Disallowed:

- `domain -> contracts`
- `domain -> read-models`
- `contracts -> message-hub router/transports`
- `read-models -> message-hub router/transports`
- new architecture files -> root `@neokai/shared`
- web code -> `compat/message-hub` server/router internals

## Validation Baseline

Every M1 PR should run:

```bash
bun run check
bun run architecture:file-size-report -- --changed-from origin/dev
```

M1.1 and later export-map PRs should also run the new shared export parity check once it exists.

## Release Evidence Requirements

Each M1 PR evidence record should include:

- phase label;
- root import count before/after for touched package or directory;
- exported subpaths added/removed;
- compatibility exports preserved;
- validation commands and results;
- file-size report;
- rollback note;
- explicit list of deferred definition moves.

## Risks

| Risk | Mitigation |
| --- | --- |
| Export map change breaks an existing hidden consumer. | Keep root export stable; only remove missing subpaths with no repo imports, or add compatibility files instead. |
| Subpaths become another broad barrel. | Keep each new file type-only and under 300 lines; split by domain/read-model/contract when it grows. |
| Forge contract names conflict with legacy `evolution.*` RPC names. | Put `forge.*` target names in contracts and keep `evolution.*` only in compatibility adapters. |
| Import enforcement blocks unrelated work. | Start advisory or limit enforcement to migrated slices. |
| Shared starts owning daemon behavior. | Keep repositories, managers, runtime adapters, prompt renderers, plugin loaders, and transport internals out of domain/contracts/read-models. |

## Recommended Next PR

Start with M1.1. It is the lowest-risk foundation: export parity, skeleton subpaths, and `compat/root.ts`. No caller migration should be required in that PR.
