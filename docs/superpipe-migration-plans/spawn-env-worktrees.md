# Spawn-env and worktrees migration plan

Per ADR 0004 (`docs/adr/0004-superpipe-pipelines.md`), this plan covers the
spawn-sanitization surface delivered by the 0g series: environment builders,
workflow hook validator environments, ACP credential scoping, and worktree
lifecycle. Planning only; no source code changes.

## Scope and combinator fit

| Site | Proposed shape | Notes |
| --- | --- | --- |
| `worktree-manager.ts` `createWorktree` provision path | One raw superpipe `create-session-worktree` (P7 read→plan→apply) | Stale-branch check (read), branch reuse/delete (effect), `worktree add` with smudge skip (effect), tolerated submodule update (`?dep`), LFS hydration (nested pipeline call), rollback plan + compensation effects in reverse. Today failure ordering lives in try/catch plus a `branchProvisioned` flag; the pipeline makes compensation order declarative. Resources (simple-git instances, fs paths) stay in the manager class. |
| `space/managers/space-worktree-manager.ts` hydrate/probe path | Same pipeline shape as `create-session-worktree`, shared stage group | Both managers delegate to `runWorktreeLfsHydration` already; unify the surrounding provision/rollback stages rather than duplicating them. |
| `space/runtime/hook-executor.ts` `buildHookRestrictedEnv` | One sync pipeline `build-hook-env` (`.end`) | Stages: resolve connector auth → seed always-allowed baseline via `startupEnvValue` → inject HYPERNEO_* context → serialize JSON payloads → filter caller scriptEnv against restricted prefixes/patterns/credential-path sets. Every stage pure; decision-table tests per filter rule. Not hot (once per hook run). |
| `lib/spawn-env.ts` builder family | Plain functions — no pipeline | The builders are already minimal pure expressions over key lists; pipelining adds ceremony without clarity (ADR Decision 8 spirit). |
| `lib/worktree-lfs.ts` pointer scanner | Excluded — plain incremental helper | Per-line state machine inside a byte stream loop is the hot-inner-loop/fold pattern ADR 0004 excludes. It is *called by* a stage of the probe flow, never composed as one. |

## Tests

Pin behavior before refactoring: existing suites (`worktree-manager.test.ts`,
`workflow-hook-engine.test.ts`, `spawn-env.test.ts`,
`worktree-lfs*.test.ts`) are the parity proof; add per-stage unit tests when
each pipeline lands.

## Focused PR breakdown

1. `create-session-worktree` pipeline in `WorktreeManager` (compensation chain
   + parity tests).
2. Shared provision/rollback stage group adopted by `SpaceWorktreeManager`.
3. `build-hook-env` pipeline with per-stage decision tables.
