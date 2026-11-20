# Make the DB operation registry readable by system-map

## 中文摘要

目标：让 system-map 静态分析工具能解析所有数据库操作路由，一个不留。当前 255 个路由已命名，8 个不可读，7 个命名错误。PR #11388 试图通过教分析器展开 spread 和求值工厂函数来解决，但 531 行代码改变了 0 个真实路由。本设计选择更简单的方案：改注册表代码本身，让名字和 spread 对静态分析显而易见。具体做法：内联 `SDK_MESSAGE_TRANSACTIONS` 数组、把 `sdkOp()` 工厂改为直接调用 `defineDbOp` 并传入字面量名字。分析器只需处理字面量，不需要展开或求值。

## Problem

The system-map static route tool resolves database-operation routes to their named superpipe pipelines. On current dev it reports 255 named, 7 misnamed, 8 unreadable. PR #11388 (head d48cfca76d) adds a strict analyzer that traces `gatewayFor().call(command, method, ...)` through the `DB_OPS` registry to a named runner. It resolves 0 of the 277 real registered methods because two patterns in the registry are opaque to static analysis:

1. **Spread element.** `db-ops.ts:298` contains `...SDK_MESSAGE_TRANSACTIONS` inside the `DB_OPS` array literal. The analyzer's `isRegistrationList` requires every element to be an identifier; a spread makes it return undefined for the entire array.

2. **Name-building factory.** `sdk-message-transactions.ts:53` defines `sdkOp(name, run)` which calls `defineDbOp({ name: \`sdk_messages.${name}\`, ... })`. The analyzer's `registrationKey` reads the first argument to `defineDbOp` as a string literal; a template literal makes it return undefined.

These two patterns block the analyzer from confirming that any `defineRepositoryOp` export is registered in `DB_OPS`, so all 277 methods stay unknown.

Separately, 8 operation routes are unreadable because the analyzer cannot trace through intermediate functions (e.g. `save` calls `service.repo.saveProjectCurrent()` which calls `gatewayFor().call(...)`). That is a different analysis problem, not a registry problem.

## Decision

Change the registry code so names and spreads are statically obvious. Do not teach the analyzer to expand spreads or evaluate factories.

**Inline `SDK_MESSAGE_TRANSACTIONS`.** The spread exists because `sdk-message-transactions.ts` exports both individual op constants and the array. Only `db-ops.ts` imports the array. Inline the 12 elements directly into the `DB_OPS` array and delete the exported constant. The individual op exports stay.

**Replace `sdkOp()` with direct `defineDbOp` calls.** Each of the 12 ops in `sdk-message-transactions.ts` currently calls `sdkOp('name', fn)`. Change each to call `defineDbOp({ name: 'sdk_messages.name', mode: 'write', run: ... })` directly. The `sdkOp` wrapper adds `applySdkBodyWriteMode` and assembles a `Dependencies` object; move that logic into a shared helper that does not build the name.

## Why not teach the analyzer

Expanding spreads requires the analyzer to follow an import, find the exported array literal, and splice its elements. Evaluating factories requires it to resolve template literals and constant-fold string concatenation. Each new pattern the analyzer understands is a new way for it to be wrong. The registry code is the stable surface; the analyzer is the consumer. Making the registry declarative is one code change that eliminates both blockers permanently. It also removes the 531-line analyzer in #11388 down to what the fixture needs.

## What happens to #11388

Reuse the test fixtures and the `confinedWorkerRegistration` guard. Rework or drop the spread-expansion and factory-evaluation logic. The PR's core value — tracing a `gatewayFor().call()` to a named runner through the registry — is correct once the registry is readable. The merge contract (390 production / 100 test lines) becomes reachable after removing the spread and factory handling.

The 8 unreadable operation routes (cross-file tracing through repository methods) are out of scope for this design. They need a separate analysis pass that follows method calls across files, which is a larger effort.

## Files to change

| File | Change |
|------|--------|
| `packages/daemon/src/storage/db-gateway/db-ops.ts` | Inline the 12 `SDK_MESSAGE_TRANSACTIONS` elements into the `DB_OPS` array; remove the spread and the import. |
| `packages/daemon/src/storage/repositories/sdk-message-transactions.ts` | Replace `sdkOp(name, fn)` with direct `defineDbOp({ name: 'sdk_messages.<name>', ... })` calls. Remove the `sdkOp` wrapper. Keep the shared dependency-assembly logic as a non-name-building helper. |

## Test plan

1. `bun scripts/pipeline-verdict-report.ts --strict` shows the same 255 named / 7 misnamed / 8 unreadable counts as before — no regression.
2. A unit test feeds a fixture registry (plain literals, no spread, no factory) through the analyzer and confirms it resolves.
3. `bun run check` passes.
4. The daemon boots and a write operation (e.g. `neo.project.save`) succeeds, confirming the registry still works at runtime.
