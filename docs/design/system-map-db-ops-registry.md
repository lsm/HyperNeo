# Make the DB operation registry readable by system-map

## 中文摘要

目标：让 system-map 静态分析工具解析所有数据库操作路由。当前 255 个路由已命名，8 个不可读，7 个命名错误。PR #11388 试图通过教分析器展开 spread 和求值工厂函数来解决，但 531 行代码改变了 0 个真实路由。本设计选择更简单的方案：改注册表代码本身，让名字和 spread 对静态分析显而易见。具体做法：内联 11 个 `SDK_MESSAGE_TRANSACTIONS` 元素、把 `sdkOp()` 工厂改为直接调用 `defineDbOp` 并传入字面量名字。

## Problem

The system-map static route tool resolves database-operation routes to their named superpipe pipelines. On current dev it reports 255 named, 7 misnamed, 8 unreadable. PR #11388 (head d48cfca76d) adds a strict analyzer that traces `gatewayFor().call(command, method, ...)` through the `DB_OPS` registry to a named runner. It resolves 0 of the 201 real registered operations because two patterns in the registry are opaque to static analysis:

1. **Spread element.** `db-ops.ts:298` contains `...SDK_MESSAGE_TRANSACTIONS` inside the `DB_OPS` array literal. The analyzer's `isRegistrationList` requires every element to be an identifier; a spread makes it return undefined for the entire array.

2. **Name-building factory.** `sdk-message-transactions.ts:53` defines `sdkOp(name, run)` which calls `defineDbOp({ name: \`sdk_messages.${name}\`, ... })`. The analyzer's `registrationKey` reads the `name` property from the object literal passed to `defineDbOp`; a template literal makes it return undefined.

These two patterns block the analyzer from confirming that any export is registered in `DB_OPS`, so all 201 operations stay unknown.

## Verified route analysis

I ran the strict verdict report and opened every non-named route.

**Same-file pipeline, multi-statement execute (4 routes).** These routes have a matching superpipe in the same file, but the strict analyzer cannot follow their multi-statement async execute:

| Route | Pipeline | Location |
|-------|----------|----------|
| `neo.ask.doneTodos` | `neo.ask.doneTodos` | ask-entries.ts:355 |
| `neo.conversation.read` | `neo.conversation.read` | conversation-read-operation.ts:48 |
| `neo.publication.publish` | `neo.publication.publish` | publication-operation.ts:161 |
| `neo.todo.done` | `neo.todo.done` | todo-mutation-operation.ts:200 |

Fix: extend the analyzer to handle `const result = await pipeline(...); return ...` patterns.

**Cross-file through gateway (2 routes).** These routes call a repository method that goes through the gateway before reaching the pipeline:

- `neo.project.save`: execute → `repo.saveProjectCurrent()` → `gatewayFor().call(neoProjectMoveWrites, 'save')` → `saveNeoProjectCommand` (pipeline in project-save.ts:30).
- `neo.project.forget`: execute → `repo.forgetProjectCommand()` → `gatewayFor().call(neoProjectForgetWrites, 'forget')` → `runNeoProjectForget` (pipeline in project-forget-operation.ts:32).

Fix: extend the analyzer with a cross-file pass that follows repository methods into `gatewayFor().call()` and then into the repository command's method. Preserve the gateway call — do not refactor to bypass it, or serialization is lost.

**Opaque service callback (1 route).** `connections.google.connect` calls `(await service()).connectPipeline(input)`. The pipeline exists in lifecycle.ts:231 but is wrapped in a `serial` closure. Direct import would bypass serialization. Fix: extend the analyzer to follow `(await service()).method()` by resolving the service factory's return type. Preserve the `serial` wrapper.

**Misnamed routes (7 routes).** Rename the pipelines to match operation names:

| Operation | Current pipeline |
|-----------|-----------------|
| `evolution.scope.owner.set` | `scope-owner-set-pipeline` |
| `goal.owner.set` | `goal-owner-set-pipeline` |
| `space.audit.list` | `space-audit-list` |
| `gmail.search` | `gmail-session-search` |
| `google.accounts` | `google-session-accounts` |
| `work.queue` | `change-queued-work-input` |
| `work.withdraw` | `change-queued-work-input` |

For `work.queue` and `work.withdraw`, inline two separate pipeline definitions. A shared factory would be opaque to the analyzer. The duplication is 41 lines each; acceptable for analyzer clarity.

## Decision

Change the registry code so names and spreads are statically obvious. Do not teach the analyzer to expand spreads or evaluate factories.

**Inline `SDK_MESSAGE_TRANSACTIONS`.** Only `db-ops.ts` imports the array. Inline the 11 elements directly into the `DB_OPS` array and delete the exported constant. The individual op exports stay.

**Replace `sdkOp()` with direct `defineDbOp` calls.** Extract the dependency assembly into a plain helper `sdkDependencies(db, changes)` that does not build the name. Each op then reads:

```ts
export const sdkPromptEnsure = defineDbOp({
  name: 'sdk_messages.ensurePrompt',
  mode: 'write',
  run: (db, args, changes) => {
    applySdkBodyWriteMode(db, args);
    return ensurePromptInTransaction({ ...sdkTransactionArgs(args), ...sdkDependencies(db, changes) });
  },
});
```

## Why not teach the analyzer

Expanding spreads requires the analyzer to follow an import, find the exported array literal, and splice its elements. Evaluating factories requires it to resolve template literals and constant-fold string concatenation. Each new pattern the analyzer understands is a new way for it to be wrong. The registry code is the stable surface; the analyzer is the consumer. Making the registry declarative is one code change that eliminates both blockers permanently. It also cuts the 531-line analyzer in #11388 down to what the fixture needs.

## What happens to #11388

Reuse the test fixtures and the `confinedWorkerRegistration` guard. Rework or drop the spread-expansion and factory-evaluation logic. Extend the analyzer with: (a) multi-statement async execute handling, (b) cross-file pass for repository methods, (c) `gatewayRun` handler for `gatewayFor().run(op, args)`, (d) service-method resolution for `(await service()).method()` patterns. The 11 SDK transactions use `defineDbOp`; the analyzer confirms registration via `registrationKey` without tracing to a pipeline.

## Existing test

`packages/daemon/tests/unit/4-space-storage/storage/sdk-message-transactions.test.ts:146` imports `SDK_MESSAGE_TRANSACTIONS` and asserts each op is in `DB_OPS`. When the export is removed, change the test to import the individual op constants and assert each is in `DB_OPS`. The assertion `toHaveLength(11)` becomes a count of the imported constants.

## Files to change

| File | Change |
|------|--------|
| `packages/daemon/src/storage/db-gateway/db-ops.ts` | Inline the 11 `SDK_MESSAGE_TRANSACTIONS` elements into the `DB_OPS` array; remove the spread and the import. |
| `packages/daemon/src/storage/repositories/sdk-message-transactions.ts` | Replace `sdkOp(name, fn)` with direct `defineDbOp({ name: 'sdk_messages.<name>', ... })` calls. Remove the `sdkOp` wrapper. Extract a `sdkDependencies(db, changes)` helper. |
| `packages/daemon/tests/unit/4-space-storage/storage/sdk-message-transactions.test.ts` | Replace `SDK_MESSAGE_TRANSACTIONS` import with individual op imports; update the registration assertion. |

## Sequencing

1. **This design:** registry fix (inline spread, replace factory, update test).
2. **#11388 rework:** drop spread/factory handling, add multi-statement execute, cross-file pass, `gatewayRun` handler, service-method resolution.
3. **Route fixes:** rename misnamed pipelines, inline shared queue pipeline.
4. **Coverage proof:** independent inventory + assertion + timing (below).

Steps 2 and 3 can proceed in parallel after step 1 merges.

## Test plan

**Independent inventory.** A script reads all files matching `isSource` in system-map.ts (packages/*/src, .ts and .tsx, excluding .d.ts, tests, __tests__, __mocks__, .test., .spec.), finds every `defineOperation(` call, extracts the `name` argument and, for duplicate names, the `inputSchema` hash (same algorithm as `schemaVariant`). Writes `file:name:variant` tuples. This inventory is independent of the analyzer.

**Coverage assertion.** Run `bun scripts/pipeline-verdict-report.ts --strict` and assert:
- Every `file:name:variant` tuple in the inventory appears in the report with verdict `named`.
- The report contains no routes absent from the inventory.
- Zero routes with verdict `unreadable` or `misnamed`.

**Timing assertion.** The whole command (`bun scripts/pipeline-verdict-report.ts --strict`) completes in under 2 seconds on the CI runner. Current baseline: ~1.5 seconds end-to-end on the author's machine (866 ms source I/O + 1033 ms analysis). The 1-second target is not achievable while source I/O alone takes ~870 ms; 2 seconds is the achievable limit.

**Negative cases.** A fixture with an unregistered `defineDbOp` stays unresolved. A fixture with a `defineRepositoryOp` whose methods array contains a non-literal stays unresolved. A fixture with a spread in the registry stays unresolved. A fixture with a missing schema variant for duplicate names throws. An inventory that omits a route causes the coverage assertion to fail.

**Existing test.** The sdk-message-transactions test passes with individual op imports.

**Repo checks.** `bun run check` passes.
