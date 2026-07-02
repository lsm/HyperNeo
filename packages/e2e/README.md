# E2E Tests

This package contains end-to-end tests for HyperNeo using Playwright.

## Running Tests Locally

### Important: Avoid Port Conflicts

The default Playwright configuration uses port **9283**. If you're running a development server on this port, you must either:

1. **Reuse your existing server** (recommended):
   ```bash
   PLAYWRIGHT_BASE_URL=http://localhost:9283 bun test
   ```

2. **Use a different port for testing**:
   ```bash
   PLAYWRIGHT_BASE_URL=http://localhost:9999 bun test
   ```

### Running All Tests

```bash
bun test
```

### Running Specific Tests

```bash
# Run a specific test file
bunx playwright test tests/reconnection-basic.e2e.ts

# Run tests matching a pattern
bunx playwright test reconnection
```

### Test Modes

```bash
# UI mode (interactive)
bun run test:ui

# Headed mode (see browser)
bun run test:headed

# Debug mode
bun run test:debug

# With coverage
bun run test:coverage
```

## Test Organization

Tests are organized by functionality into the following directories:

### Directory Structure

```
tests/
├── smoke/          # Quick critical path tests (< 1 minute total)
│   ├── session-creation.e2e.ts
│   ├── message-send.e2e.ts
│   └── connection-basic.e2e.ts
│
├── core/           # Core functionality (critical regression tests)
│   ├── connection-resilience.e2e.ts  ⚠️ Critical: Safari background tab bug
│   ├── session-lifecycle.e2e.ts      ⚠️ Critical: 2-stage creation
│   ├── model-selection.e2e.ts        ⚠️ Critical: Model persistence
│   ├── interrupt-error-bug.e2e.ts    ⚠️ Critical: Interrupt race condition
│   ├── message-flow.e2e.ts
│   ├── message-input.e2e.ts
│   ├── context-features.e2e.ts
│   ├── persistence.e2e.ts
│   ├── scroll-behavior.e2e.ts
│   └── interrupt-button.e2e.ts
│
├── features/       # Secondary features
│   ├── archive.e2e.ts
│   ├── draft.e2e.ts
│   ├── file-attachment.e2e.ts
│   ├── rewind-features.e2e.ts
│   ├── session-operations.e2e.ts
│   └── ... (11 files total)
│
├── settings/       # Configuration and settings
│   ├── global-settings.e2e.ts        ⚠️ Critical: Settings propagation
│   ├── mcp-servers.e2e.ts
│   ├── tools-modal.e2e.ts
│   └── ... (5 files total)
│
├── responsive/     # Responsive design
│   ├── mobile.e2e.ts
│   └── tablet.e2e.ts
│
├── serial/         # Tests requiring serial execution
│   ├── auth-error-scenarios.e2e.ts
│   ├── multi-session-operations.e2e.ts
│   └── ... (6 files total)
│
└── read-only/      # Tests that don't modify state
    ├── home.e2e.ts
    └── ui-components.e2e.ts
```

### Test Projects

The test suite is divided into 7 Playwright projects:

1. **smoke** - Quick smoke tests (run first for fast feedback)
2. **read-only** - UI tests without state modification
3. **core** - Critical functionality (includes 6 regression tests)
4. **features** - Secondary features
5. **settings** - Configuration tests
6. **responsive** - Mobile and tablet tests
7. **serial** - Tests requiring sequential execution

### Critical Regression Tests

The following tests protect against known bugs (⚠️ marked above):

1. **connection-resilience.e2e.ts** - Safari background tab message sync
2. **session-lifecycle.e2e.ts** - 2-stage session creation (instant UI)
3. **model-selection.e2e.ts** - Model persistence before first message
4. **model-selection.e2e.ts** - Duplicate model filtering
5. **interrupt-error-bug.e2e.ts** - Interrupt race condition
6. **global-settings.e2e.ts** - Global settings propagation to new sessions

### Running Specific Test Groups

```bash
# Run only smoke tests (fast)
bunx playwright test --project=smoke

# Run only core tests
bunx playwright test --project=core

# Run only features
bunx playwright test --project=features

# Run multiple projects
bunx playwright test --project=smoke --project=core

# Run all except serial
bunx playwright test --project=smoke --project=core --project=features
```

## Environment Variables

- `PLAYWRIGHT_BASE_URL` - URL of the server to test (default: http://localhost:9283)
- `COVERAGE` - Set to "true" to collect coverage reports
- `CI` - Automatically set in CI environments
- `DEFAULT_MODEL` - AI model to use for tests (default: sonnet)

## Troubleshooting

### Port Already in Use

If you see "port 9283 is already in use", either:
- Stop the conflicting process
- Use `PLAYWRIGHT_BASE_URL` to point to your existing server
- Change the port in your dev server

### Tests Timing Out

Increase timeouts in `playwright.config.ts` if tests are timing out in your environment.
