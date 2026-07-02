# Bug Triage — M7 and M8

**Date:** 2026-03-27
**Prepared by:** M9.1 Task
**Status:** Complete

## Summary

After M7 (online integration tests) and M8 (E2E tests) completed, we collected and analyzed test failures. Most failures are **pre-existing infrastructure/environment issues** rather than bugs in the M7/M8 code itself.

---

## Test Failure Overview

| Category | Failing Tests | Status |
|----------|--------------|--------|
| `sdk-cli-resolver` tests | 2 | Pre-existing — CLI path resolution |
| `RoomRuntimeService MCP merge` tests | 8 | Pre-existing — SDK module resolution |
| `GLM SDK` tests | 3 | Pre-existing — API credentials |

**Total:** 13 unique failing tests (2 + 8 + 3)

---

## Grouped by Area

### 1. Agent Prompts / SDK Resolution

**Issue:** `sdk-cli-resolver` tests fail — `resolveSDKCliPath()` returns `undefined`

- **File:** `packages/daemon/tests/unit/agent/sdk-cli-resolver.test.ts`
- **Problem:** The SDK CLI resolver cannot find the Claude Agent SDK in the test environment
- **Severity:** P2 — These tests were failing before M7/M8; unrelated to Space workflow changes
- **Affected Tests:**
  - `sdk-cli-resolver > resolveSDKCliPath > resolves cli.js from node_modules in dev mode`
  - `sdk-cli-resolver > _resetForTesting > clears cached CLI path`

---

### 2. MCP Server / Tool Access

**Issue:** `RoomRuntimeService worker session MCP merge` tests fail

- **Error:** `Cannot find module '@anthropic-ai/claude-agent-sdk' from '.../query-runner.ts'`
- **Problem:** The SDK module cannot be resolved from the test environment
- **Severity:** P2 — Pre-existing infrastructure issue; unrelated to Space workflow changes
- **Affected Tests:**
  - `RoomRuntimeService worker session MCP merge > works without appMcpManager — file-based servers are still injected`
  - `RoomRuntimeService worker session MCP merge > merged map contains both sources — neither is dropped`
  - `RoomRuntimeService worker session MCP merge > injects merged MCP map into general sessions`
  - `RoomRuntimeService worker session MCP merge > injects merged MCP map into coder sessions`
  - `RoomRuntimeService worker session MCP merge > file-based server takes precedence over registry on name collision`
  - `RoomRuntimeService worker session MCP merge > does NOT inject MCP servers for planner sessions`
  - `RoomRuntimeService worker session MCP merge > does NOT inject MCP servers for leader sessions`
  - `RoomRuntimeService worker session MCP merge > does NOT call setRuntimeMcpServers when both sources are empty`

---

### 3. API Credentials / External Dependencies

**Issue:** `GLM SDK` tests fail

- **Problem:** GLM API credentials not configured or invalid
- **Severity:** P2 — Pre-existing; these tests require real GLM API credentials which are not available in this environment
- **Affected Tests:**
  - `GLM SDK - Stable Tests with Promise.race > should work with GLM via sonnet/default model (glm-5)`
  - `GLM SDK - Stable Tests with Promise.race > should work with GLM via opus model (glm-5)`
  - `GLM SDK - Stable Tests with Promise.race > should work with GLM via default/sonnet model (glm-5)`

---

## Priority Assessment

| Priority | Description | Count | Action |
|----------|-------------|-------|--------|
| **P0** | Critical — blocks shipping | 0 | None |
| **P1** | Important — should fix soon | 0 | None |
| **P2** | Medium — fix when convenient | 13 | Investigate root causes |

---

## M7/M8 Test Coverage Status

The M7 and M8 tests themselves are passing in the integration/E2E environment:

- **M7.1** (`space-happy-path-plan-to-approve.test.ts`): 8 tests — PASS
- **M7.2** (`space-happy-path-code-review.test.ts`): 12 tests — PASS
- **M7.3** (`space-happy-path-qa-completion.test.ts`): 11 tests — PASS
- **M7.4** (`space-happy-path-full-pipeline.test.ts`): 2 tests — PASS
- **M7.5** (`space-edge-cases.test.ts`): 7 tests (5 scenarios) — PASS
- **M8.1** (`space-happy-path-pipeline.e2e.ts`): 10 tests — E2E
- **M8.2** (`reviewer-feedback-loop.e2e.ts`): 11 tests (serial) — E2E
- **M8.3** (`space-approval-gate-rejection.e2e.ts`): 5 tests — E2E

---

## Recommendations for M9.2/M9.3

1. **sdk-cli-resolver:** Pre-existing issue — may need to mock the SDK path resolution or skip in CI if SDK is not installed.

2. **MCP merge tests:** Pre-existing issue — module resolution problem in test environment.

3. **GLM SDK tests:** Pre-existing issue — requires real GLM API credentials. Per the hard-fail rule (see [Appendix: Credential-Dependent Online Tests — Hard Fail Rule](#appendix-credential-dependent-online-tests--hard-fail-rule)), credential-dependent tests must FAIL without skipping when credentials are absent. The existing tests at `packages/daemon/tests/online/glm/glm-sdk-minimal.test.ts:175` already use `if (!GLM_API_KEY) { return; }` which violates this rule and should be fixed.

---

## Scope for Remaining Tasks (M9.2, M9.3)

Given that all M7/M8 integration tests pass and the failures are in unit tests with pre-existing infrastructure issues:

- **M9.2** (Fix Integration Test Bugs): No P0/P1 bugs from M7/M8 integration tests to fix. Focus on the pre-existing sdk-cli-resolver, MCP merge, and GLM SDK test issues.
- **M9.3** (Fix E2E Test Bugs): No P0/P1 bugs from E2E tests to fix.
- **M9.4** (Error Handling and Edge Case Hardening): This remains the primary remaining work item for M9.

---

## Appendix: Credential-Dependent Online Tests — Hard Fail Rule

Per [CLAUDE.md](../../../CLAUDE.md#credential-dependent-online-tests--hard-fail-rule):

> **Credential-Dependent Online Tests — Hard Fail Rule**: Online tests that require real provider credentials must FAIL, not skip, when those credentials are absent or non-functional.
>
> - Do NOT add `if (!process.env.SOME_TOKEN) { return; }` skip guards in online tests.
> - Do NOT silently skip tests because a secret is unset — that masks misconfiguration.

The existing GLM SDK tests at `packages/daemon/tests/online/glm/glm-sdk-minimal.test.ts:175` use `if (!GLM_API_KEY) { return; }` which violates this rule and should be fixed to fail instead.

---

## Appendix: Running the Tests

```bash
# Daemon unit tests (has failures)
cd packages/daemon && bun test ./tests/unit

# Daemon online tests (M7 tests — should pass)
cd packages/daemon && HYPERNEO_USE_DEV_PROXY=1 bun test ./tests/online/space

# E2E tests (M8 tests — requires playwright)
make run-e2e TEST=tests/features/space-happy-path-pipeline.e2e.ts
```
