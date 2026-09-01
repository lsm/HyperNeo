# Milestone 07: Daemon — Core Service Tests

## Goal

Write unit tests for the major untested daemon service files. These are more complex than repositories (they have side effects, external dependencies, and rich business logic) and require careful mocking. Focus on the files with the highest line count and broadest business impact.

## Scope

| File | Lines | Complexity | Shard |
|------|-------|------------|-------|
| `lib/rpc-handlers/index.ts` | 805 | High | 2-handlers |
| `lib/daemon-hub.ts` | 633 | High | 1-core |
| `lib/github/github-service.ts` | 652 | Medium | 2-handlers |
| `lib/providers/registry.ts` | 268 | Medium | 1-core |
| `lib/providers/factory.ts` | 108 | Medium | 1-core |
| `lib/agent/coordinator/*.ts` | ~250 total | Low-Medium | 1-core |
| `lib/lobby/index.ts` | 20 | Low | 2-handlers |
| `lib/short-id-allocator.ts` | — | Low | 1-core |

---

## Task 7.1: Write tests for rpc-handlers/index.ts

**Agent type**: coder

**Description**

`lib/rpc-handlers/index.ts` (805 lines) is the main RPC dispatch layer — it maps incoming WebSocket/HTTP messages to handler functions. This file is in shard `2-handlers`. The existing `neo-handlers.test.ts` covers neo-specific handlers; this task covers the non-neo handlers.

**Files to read first**

- `packages/daemon/src/lib/rpc-handlers/index.ts`
- An existing handler test in `packages/daemon/tests/unit/2-handlers/rpc-handlers/` for patterns
- `packages/daemon/tests/unit/setup.ts` for the SDK mock setup

**Files to create**

- `packages/daemon/tests/unit/2-handlers/rpc-handlers/rpc-handler-dispatch.test.ts`

**Subtasks**

1. Read `rpc-handlers/index.ts` to identify the handler registration pattern and the set of RPC method names handled.
2. Mock the dependencies: room manager, session manager, auth, and any DB access.
3. Write tests for the most frequently called RPC methods (e.g., `createSession`, `sendMessage`, `getRoom`, `updateSettings`).
4. Test error handling paths: unknown method returns error, malformed payload returns validation error.
5. Test authentication/authorization checks if present.
6. Aim for 50%+ line coverage (the file is large; focus on the highest-traffic paths).

**Acceptance criteria**

- Test file exists and passes in the 2-handlers shard.
- `rpc-handlers/index.ts` shows at least 50% line coverage.
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

**Depends on**: Milestone 01 (Bun all-files workaround so the file is visible in coverage).

---

## Task 7.2: Write tests for daemon-hub.ts

**Agent type**: coder

**Description**

`lib/daemon-hub.ts` (633 lines) is the central hub that coordinates between rooms, sessions, and the agent lifecycle. It has complex lifecycle management. Belongs in shard `1-core`.

**Files to read first**

- `packages/daemon/src/lib/daemon-hub.ts`
- `packages/daemon/tests/unit/1-core/core/` for existing hub-adjacent tests
- `packages/daemon/tests/unit/setup.ts`

**Files to create**

- `packages/daemon/tests/unit/1-core/core/daemon-hub.test.ts`

**Subtasks**

1. Read `daemon-hub.ts` to identify the public API surface: initialization, room registration, session routing, event dispatch.
2. Mock the database, room manager, and agent SDK.
3. Write tests for: hub initialization, room creation routing, session handoff, cleanup on shutdown.
4. Test event emission/handling if the hub uses an event bus.
5. Given the complexity, aim for 40%+ line coverage with focus on the most critical paths.

**Acceptance criteria**

- Test file exists and passes in the 1-core shard.
- `daemon-hub.ts` shows at least 40% line coverage.
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

**Depends on**: Milestone 01.

---

## Task 7.3: Write tests for github-service.ts

**Agent type**: coder

**Description**

`lib/github/github-service.ts` (652 lines) handles GitHub API interactions: OAuth token management, repo operations, PR creation, and webhook processing. Shard `2-handlers`.

**Files to read first**

- `packages/daemon/src/lib/github/github-service.ts`
- `packages/daemon/tests/unit/2-handlers/github/` (if any existing github tests)

**Files to create**

- `packages/daemon/tests/unit/2-handlers/github/github-service.test.ts`

**Subtasks**

1. Read `github-service.ts` to identify public methods and the HTTP client it uses.
2. Mock the HTTP client (fetch or a GitHub SDK) to return fixture responses.
3. Write tests for: OAuth token exchange, `getRepo`, `createPR`, `listPRs`, `getCommit`.
4. Test error handling: 401 returns auth error, 404 returns not-found error, rate limit returns retry-able error.
5. Aim for 60%+ line coverage.

**Acceptance criteria**

- Test file exists and passes.
- `github-service.ts` shows at least 60% line coverage.
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

**Depends on**: Milestone 01.

---

## Task 7.4: Write tests for providers/registry.ts and providers/factory.ts

**Agent type**: coder

**Description**

`lib/providers/registry.ts` (268 lines) manages the provider registry (LLM provider registrations). `lib/providers/factory.ts` (108 lines) creates provider instances from config. Both belong in shard `1-core`. Note: `setup.ts` already calls `resetProviderRegistry()` before each test run, so the registry is reset between test files.

**Files to read first**

- `packages/daemon/src/lib/providers/registry.ts`
- `packages/daemon/src/lib/providers/factory.ts`
- `packages/daemon/tests/unit/1-core/providers/` (check existing provider tests)
- `packages/daemon/tests/unit/setup.ts` (note the `resetProviderRegistry()` call)

**Files to create**

- `packages/daemon/tests/unit/1-core/providers/registry.test.ts`
- `packages/daemon/tests/unit/1-core/providers/factory.test.ts`

**Subtasks**

1. For `registry.ts`:
   - Test provider registration (happy path).
   - Test duplicate registration behavior.
   - Test `getProvider` with known and unknown provider names.
   - Test `resetProviderRegistry` clears all registrations.
2. For `factory.ts`:
   - Test that `createProvider` returns the expected provider instance given valid config.
   - Test that unsupported provider type throws a descriptive error.
3. Mock the actual provider implementations (just register mock objects).

**Acceptance criteria**

- Both test files exist and pass.
- `registry.ts` shows at least 75% line coverage; `factory.ts` shows at least 80%.
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

**Depends on**: Milestone 01.

---

## Task 7.5: Write tests for coordinator agent files and short-id-allocator

**Agent type**: coder

**Description**

The `lib/agent/coordinator/` directory contains 7 small files (~30-60 lines each) that define specialized coordinator agent behaviors (coder, reviewer, verifier, debugger, tester, vcs, coordinator). These are small enough to test comprehensively. Also cover `lib/short-id-allocator.ts`.

**Files to read first**

- `packages/daemon/src/lib/agent/coordinator/coordinator.ts`
- `packages/daemon/src/lib/agent/coordinator/coder.ts`
- `packages/daemon/src/lib/agent/coordinator/reviewer.ts`
- `packages/daemon/src/lib/agent/coordinator/verifier.ts`
- `packages/daemon/src/lib/short-id-allocator.ts`
- `packages/daemon/tests/unit/1-core/agent/coordinator-agents.test.ts` (existing test — check what is already covered)

**Files to create or modify**

- Extend `packages/daemon/tests/unit/1-core/agent/coordinator-agents.test.ts` OR
- Create `packages/daemon/tests/unit/1-core/agent/coordinator-agents-extended.test.ts`
- Create `packages/daemon/tests/unit/1-core/lib/short-id-allocator.test.ts`

**Subtasks**

1. Check the existing `coordinator-agents.test.ts` to see which coordinator types are already covered.
2. Add tests for any uncovered coordinator types (coder, reviewer, verifier, debugger, tester, vcs).
3. For `short-id-allocator.ts`: test allocation uniqueness, sequential generation, and reset behavior.
4. Mock the Claude agent SDK (already mocked by `setup.ts`).

**Acceptance criteria**

- All coordinator files show at least 80% line coverage.
- `short-id-allocator.ts` shows at least 90% line coverage.
- All new/modified tests pass in the 1-core shard.
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

**Depends on**: Milestone 01.
