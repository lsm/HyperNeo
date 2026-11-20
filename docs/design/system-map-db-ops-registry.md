# Make the DB operation registry readable by system-map

## 中文摘要

目标：让 system-map 静态分析工具在一秒内解析所有数据库操作路由。当前 255 个路由已命名，8 个不可读，7 个命名错误。PR #11388 试图通过教分析器展开 spread 和求值工厂函数来解决，但 531 行代码改变了 0 个真实路由。本设计选择更简单的方案：改注册表代码本身，让名字和 spread 对静态分析显而易见。具体做法：内联 11 个 `SDK_MESSAGE_TRANSACTIONS` 元素、把 `sdkOp()` 工厂改为直接调用 `defineDbOp` 并传入字面量名字。分析器只需处理字面量，不需要展开或求值。

## Problem

The system-map static route tool resolves database-operation routes to their named superpipe pipelines. On current dev it reports 255 named, 7 misnamed, 8 unreadable. PR #11388 (head d48cfca76d) adds a strict analyzer that traces `gatewayFor().call(command, method, ...)` through the `DB_OPS` registry to a named runner. It resolves 0 of the 201 real registered operations because two patterns in the registry are opaque to static analysis:

1. **Spread element.** `db-ops.ts:298` contains `...SDK_MESSAGE_TRANSACTIONS` inside the `DB_OPS` array literal. The analyzer's `isRegistrationList` requires every element to be an identifier; a spread makes it return undefined for the entire array.

2. **Name-building factory.** `sdk-message-transactions.ts:53` defines `sdkOp(name, run)` which calls `defineDbOp({ name: \`sdk_messages.${name}\`, ... })`. The analyzer's `registrationKey` reads the `name` property from the object literal passed to `defineDbOp`; a template literal makes it return undefined.

These two patterns block the analyzer from confirming that any export is registered in `DB_OPS`, so all 201 operations stay unknown.

## Scope: all 15 non-named routes

This design covers the registry fix. The remaining 8 unreadable and 7 misnamed routes need separate work, sequenced after the registry fix:

**Registry fix (this design).** Inline the spread, replace the factory. After this, the analyzer can confirm every `defineRepositoryOp` and `defineDbOp` registration in `DB_OPS`.

**Cross-file tracing (3 routes).** `neo.project.save`, `neo.project.forget`, `neo.publication.read` call `gatewayFor().call()` inside repository class methods. The analyzer needs a one-level cross-file pass: when an operation's `execute` calls `service.repo.someMethod()`, follow into the repository method and look for `gatewayFor().call()`. This is a small extension to #11388's existing `gatewayCall` handler.

**Generic dispatch (2 routes).** `neo.ask.doneTodos` and `neo.todo.done` call `store.read(method)` or `deps.gateway.call(op, method)` where `method` is a variable. The analyzer cannot resolve these without evaluating the generic type parameter. These routes stay unreadable until the call sites are refactored to use literal method names (e.g. `store.read('doneTodoFacts', input.askId)` instead of `store.read(method, ...)`).

**Opaque callbacks (2 routes).** `neo.publication.publish` and `connections.google.connect` pass callbacks into a runtime object. The pipeline is reachable only through the callback. Refactor the execute functions to call the pipeline directly instead of through a callback.

**Direct DB access (1 route).** `neo.conversation.read` reads via `db.prepare()` directly, not through the gateway. This route does not go through the DB gateway at all; it is not a DB-operation route in the registry sense. The analyzer should classify it as a direct-DB route, not unreadable.

**Misnamed routes (7 routes).** Rename the pipelines to match the operation names:

| Operation | Current pipeline | New pipeline |
|-----------|-----------------|--------------|
| `evolution.scope.owner.set` | `scope-owner-set-pipeline` | `evolution.scope.owner.set` |
| `goal.owner.set` | `goal-owner-set-pipeline` | `goal.owner.set` |
| `space.audit.list` | `space-audit-list` | `space.audit.list` |
| `gmail.search` | `gmail-session-search` | `gmail.search` |
| `google.accounts` | `google-session-accounts` | `google.accounts` |
| `work.queue` | `change-queued-work-input` | `work.queue` |
| `work.withdraw` | `change-queued-work-input` | `work.withdraw` |

For `work.queue` and `work.withdraw`, duplicate the shared pipeline into two named pipelines. Each is a thin wrapper over the same logic.

**Direct DB ops (11 SDK transactions).** The SDK `defineDbOp` registrations are terminal operations, not pipeline routes. The analyzer confirms they are registered but does not trace them to pipelines. No additional work needed.

## Decision

Change the registry code so names and spreads are statically obvious. Do not teach the analyzer to expand spreads or evaluate factories.

**Inline `SDK_MESSAGE_TRANSACTIONS`.** The spread exists because `sdk-message-transactions.ts` exports both individual op constants and the array. Only `db-ops.ts` imports the array. Inline the 11 elements directly into the `DB_OPS` array and delete the exported constant. The individual op exports stay.

**Replace `sdkOp()` with direct `defineDbOp` calls.** Each of the 11 ops currently calls `sdkOp('name', fn)`. Change each to call `defineDbOp({ name: 'sdk_messages.name', mode: 'write', run: ... })` directly. The `sdkOp` wrapper does three things: builds the name via template literal, calls `applySdkBodyWriteMode`, and assembles a `Dependencies` object. Extract the dependency assembly into a plain helper `sdkDependencies(db, changes)` that does not build the name. Each op then reads:

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

Reuse the test fixtures and the `confinedWorkerRegistration` guard. Rework or drop the spread-expansion and factory-evaluation logic. The PR's core value — tracing a `gatewayFor().call()` to a named runner through the registry — is correct once the registry is readable. The merge contract (390 production / 100 test lines) becomes reachable after removing the spread and factory handling.

Extend the analyzer with a one-level cross-file pass for repository method calls (the 3 cross-file routes). Add a `gatewayRun` handler for `gatewayFor().run(op, args)` alongside the existing `gatewayCall` handler. The 11 SDK transactions use `defineDbOp`; the analyzer confirms registration via `registrationKey` without tracing to a pipeline.

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
2. **#11388 rework:** drop spread/factory handling, add cross-file pass, add `gatewayRun` handler.
3. **Route fixes:** refactor generic dispatch call sites, opaque callbacks, direct DB access, rename misnamed pipelines.
4. **Coverage proof:** independent inventory + assertion + timing (below).

Steps 2 and 3 can proceed in parallel after step 1 merges.

## Test plan

**Independent inventory.** A script greps for `defineOperation(` across `packages/daemon/src/` and `packages/space/src/`, extracts the `name` argument from each call, and writes the names to a file. This inventory is independent of the analyzer.

**Coverage assertion.** Run `bun scripts/pipeline-verdict-report.ts --strict` and assert:
- Every name in the independent inventory appears in the report.
- Every route in the report has verdict `named` (zero `unreadable`, zero `misnamed`).
- The set of report names equals the set of inventory names (no omissions, no additions).

**Timing assertion.** The strict report completes in under 2 seconds on the CI runner. Current baseline: ~1.5 seconds on the author's machine.

**Negative cases.** A fixture with an unregistered `defineDbOp` stays unresolved. A fixture with a `defineRepositoryOp` whose methods array contains a non-literal stays unresolved. A fixture with a spread in the registry stays unresolved.

**Existing test.** The sdk-message-transactions test passes with individual op imports.

**Repo checks.** `bun run check` passes.
