# Make the DB operation registry readable by system-map

## 中文摘要

目标：让 system-map 静态分析工具在一秒内解析所有数据库操作路由。当前 255 个路由已命名，8 个不可读，7 个命名错误。PR #11388 试图通过教分析器展开 spread 和求值工厂函数来解决，但 531 行代码改变了 0 个真实路由。本设计选择更简单的方案：改注册表代码本身，让名字和 spread 对静态分析显而易见。具体做法：内联 11 个 `SDK_MESSAGE_TRANSACTIONS` 元素、把 `sdkOp()` 工厂改为直接调用 `defineDbOp` 并传入字面量名字。分析器只需处理字面量，不需要展开或求值。

## Problem

The system-map static route tool resolves database-operation routes to their named superpipe pipelines. On current dev it reports 255 named, 7 misnamed, 8 unreadable. PR #11388 (head d48cfca76d) adds a strict analyzer that traces `gatewayFor().call(command, method, ...)` through the `DB_OPS` registry to a named runner. It resolves 0 of the 201 real registered operations because two patterns in the registry are opaque to static analysis:

1. **Spread element.** `db-ops.ts:298` contains `...SDK_MESSAGE_TRANSACTIONS` inside the `DB_OPS` array literal. The analyzer's `isRegistrationList` requires every element to be an identifier; a spread makes it return undefined for the entire array.

2. **Name-building factory.** `sdk-message-transactions.ts:53` defines `sdkOp(name, run)` which calls `defineDbOp({ name: \`sdk_messages.${name}\`, ... })`. The analyzer's `registrationKey` reads the `name` property from the object literal passed to `defineDbOp`; a template literal makes it return undefined.

These two patterns block the analyzer from confirming that any export is registered in `DB_OPS`, so all 201 operations stay unknown.

## Scope

This design covers making the registry readable. It does not cover:

- **Cross-file tracing.** Three unreadable routes (`neo.project.save`, `neo.project.forget`, `neo.publication.read`) call `gatewayFor().call()` inside repository class methods, not directly in the operation's `execute`. The analyzer needs a cross-file method-call pass to follow these.
- **Generic dispatch.** Two unreadable routes (`neo.ask.doneTodos`, `neo.todo.done`) call `gatewayFor().call(op, method)` where `method` is a generic type parameter, not a string literal. The analyzer cannot resolve generic dispatch.
- **Opaque callbacks.** Two unreadable routes (`neo.publication.publish`, `connections.google.connect`) pass callbacks into a runtime object; the pipeline is reachable only through the callback.
- **Direct DB access.** One unreadable route (`neo.conversation.read`) reads via `db.prepare()` directly, not through the gateway at all.
- **Misnamed routes.** Seven routes have pipeline names that differ from operation names (e.g. `work.queue` resolves to `change-queued-work-input`). These are intentional shared pipelines; renaming them is a separate decision.

These are tracked in #11329 and are not blocked by this design.

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

The PR's `registeredRepositoryMethod` currently only accepts `defineRepositoryOp`. The 11 SDK transactions use `defineDbOp`, which the analyzer handles separately via `registrationKey`. Making the SDK transactions readable does not itself trace those operations to pipelines; it only confirms they are registered.

## Existing test

`packages/daemon/tests/unit/4-space-storage/storage/sdk-message-transactions.test.ts:146` imports `SDK_MESSAGE_TRANSACTIONS` and asserts each op is in `DB_OPS`. When the export is removed, change the test to import the individual op constants and assert each is in `DB_OPS`. The assertion `toHaveLength(11)` becomes a count of the imported constants.

## Files to change

| File | Change |
|------|--------|
| `packages/daemon/src/storage/db-gateway/db-ops.ts` | Inline the 11 `SDK_MESSAGE_TRANSACTIONS` elements into the `DB_OPS` array; remove the spread and the import. |
| `packages/daemon/src/storage/repositories/sdk-message-transactions.ts` | Replace `sdkOp(name, fn)` with direct `defineDbOp({ name: 'sdk_messages.<name>', ... })` calls. Remove the `sdkOp` wrapper. Extract a `sdkDependencies(db, changes)` helper. |
| `packages/daemon/tests/unit/4-space-storage/storage/sdk-message-transactions.test.ts` | Replace `SDK_MESSAGE_TRANSACTIONS` import with individual op imports; update the registration assertion. |

## Test plan

1. `bun scripts/pipeline-verdict-report.ts --strict` shows zero unresolved DB-operation routes and zero misnamed DB-operation routes. The report runs in under two seconds.
2. An independent inventory script counts the registered operations by reading `DB_OPS` at runtime and confirms the count matches the analyzer's resolved count.
3. Negative cases: a fixture with an unregistered `defineDbOp` and a fixture with a `defineRepositoryOp` whose methods array contains a non-literal both stay unresolved.
4. The existing sdk-message-transactions test passes with the updated imports.
5. `bun run check` passes.
