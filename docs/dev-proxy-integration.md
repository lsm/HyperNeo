# Dev Proxy Integration for Claude Agent SDK

This document describes how to configure Dev Proxy to mock the Anthropic API for the HyperNeo test suite.

## Overview

Dev Proxy is a Microsoft tool that intercepts HTTP requests and can return mock responses. This allows us to run online tests without calling the real Anthropic API, improving test stability and reducing costs.

CI does not install the .NET binary. The `Setup Dev Proxy` action starts `scripts/dev-proxy-stub.ts`, a Bun HTTP server that serves the same `.devproxy` mock files with the same matching semantics (see [.devproxy/README.md](../.devproxy/README.md) for details and local usage).

**Sample Reference:** [pnp/proxy-samples - simulate-anthropic](https://github.com/pnp/proxy-samples/tree/main/samples/simulate-anthropic)

## Current Test Behavior (Strict Mode)

For daemon online tests, use:

```bash
cd packages/daemon && HYPERNEO_USE_DEV_PROXY=1 bun test ./tests/online/convo/multiturn-conversation.test.ts
```

When `HYPERNEO_USE_DEV_PROXY=1` is enabled in the daemon test helper:

1. Dev Proxy is mandatory for the run; startup failure causes test setup failure.
2. Real Anthropic credentials are blocked for the test process:
   - `CLAUDE_CODE_OAUTH_TOKEN=''`
   - `ANTHROPIC_AUTH_TOKEN=''`
   - `ANTHROPIC_API_KEY='sk-devproxy-test-key'`
3. Requests are routed to local Dev Proxy URL (`http://127.0.0.1:8000`).
4. Dev Proxy is reused across tests in the same process by default (`HYPERNEO_DEV_PROXY_REUSE=1`).

This prevents silent fallbacks to real credentialed Anthropic traffic.
Reuse mode removes per-test Dev Proxy start/stop overhead and is recommended for CI.

Set `HYPERNEO_DEV_PROXY_REUSE=0` to force per-test Dev Proxy lifecycle behavior.

To confirm requests were mocked:

```bash
# Optional: persist logs to .devproxy/devproxy.log when helper stops proxy
(cd packages/daemon && HYPERNEO_DEV_PROXY_CAPTURE_LOGS=1 HYPERNEO_USE_DEV_PROXY=1 bun test ./tests/online/convo/multiturn-conversation.test.ts)
tail -n 120 .devproxy/devproxy.log

# Or read directly from devproxy
devproxy logs --lines 120 --output text
```

Expected lines include:

- `req ... POST http://127.0.0.1:8000/v1/messages?beta=true`
- `mock ... MockResponsePlugin: 200 ...`

## How the Claude Agent SDK Makes HTTP Requests

Understanding the SDK's HTTP behavior is crucial for proxy integration:

### Architecture

1. **HyperNeo Daemon** calls `query()` from `@anthropic-ai/claude-agent-sdk`
2. **SDK** spawns a **CLI subprocess** (using Node.js or Bun)
3. **CLI subprocess** makes HTTP requests to `api.anthropic.com` using undici (Node.js's built-in HTTP client)
4. The subprocess **inherits environment variables** from the parent process

### Key Code Paths

```
QueryRunner.runQuery()
    └── providerService.applyEnvVarsToProcess()  // Sets process.env before SDK call
    └── query({ options: { env: mergedEnv } })   // SDK spawns subprocess
        └── Subprocess inherits process.env + options.env
            └── Makes HTTP requests to api.anthropic.com
```

**Important Files:**
- `packages/daemon/src/lib/agent/query-runner.ts` - SDK query execution
- `packages/daemon/src/lib/agent/query-options-builder.ts` - Builds SDK options including env vars
- `packages/daemon/src/lib/provider-service.ts` - Process-level env var management

### Known Issues

Per [GitHub Issue #169](https://github.com/anthropics/claude-agent-sdk-typescript/issues/169), there's a known bug where `HTTP_PROXY`/`HTTPS_PROXY` environment variables don't work with undici's ProxyAgent dispatcher.

**Workaround:** Use `NODE_USE_ENV_PROXY=1` environment variable (Node.js 18+) or `--use-env-proxy` flag.

## Environment Variables for Proxy Configuration

### Required Environment Variables

| Variable | Value | Purpose |
|----------|-------|---------|
| `HTTPS_PROXY` | `http://127.0.0.1:8000` | Route HTTPS requests through Dev Proxy |
| `HTTP_PROXY` | `http://127.0.0.1:8000` | Route HTTP requests through Dev Proxy |
| `NODE_USE_ENV_PROXY` | `1` | Enable Node.js to respect proxy env vars |

### Certificate Trust Variables (choose one)

| Variable | Value | Purpose |
|----------|-------|---------|
| `NODE_EXTRA_CA_CERTS` | Path to Dev Proxy CA cert | Trust Dev Proxy's SSL certificate |
| `NODE_TLS_REJECT_UNAUTHORIZED` | `0` | Disable TLS verification (development only!) |

### Optional Variables

| Variable | Value | Purpose |
|----------|-------|---------|
| `NO_PROXY` | `localhost,127.0.0.1` | Bypass proxy for local addresses |

## Dev Proxy Configuration

### Directory Structure

```
.devproxy/
├── devproxyrc.json    # Main configuration
├── mocks.json         # Mock response definitions
├── .devproxy.pid      # PID file (generated at runtime)
└── devproxy.log       # Log file (generated at runtime)
```

## Quick Start

### 1. Install Dev Proxy

**macOS (Homebrew):**
```bash
brew tap dotnet/dev-proxy
brew install dev-proxy
```

**Linux:**
```bash
curl -sL https://aka.ms/install-dev-proxy | bash
```

**Windows:**
```powershell
winget install Microsoft.DevProxy
```

### 2. Start Dev Proxy

Using npm scripts:
```bash
bun run test:proxy:start
# or
make test-proxy-start
```

### 3. Configure Environment

Set these environment variables before running tests:
```bash
export HTTPS_PROXY=http://127.0.0.1:8000
export HTTP_PROXY=http://127.0.0.1:8000
export NODE_USE_ENV_PROXY=1
export NODE_EXTRA_CA_CERTS=~/.proxy/rootCA.pem
```

### 4. Stop Dev Proxy

```bash
bun run test:proxy:stop
# or
make test-proxy-stop
```

### devproxyrc.json

Located at `.devproxy/devproxyrc.json`:

```json
{
  "$schema": "https://raw.githubusercontent.com/dotnet/dev-proxy/main/schemas/v2.1.0/rc.schema.json",
  "plugins": [
    {
      "name": "MockResponsePlugin",
      "enabled": true,
      "pluginPath": "~appFolder/plugins/DevProxy.Plugins.dll",
      "configSection": "mockResponsePlugin"
    }
  ],
  "urlsToWatch": ["https://api.anthropic.com/*"],
  "mockResponsePlugin": {
    "$schema": "https://raw.githubusercontent.com/dotnet/dev-proxy/main/schemas/v2.1.0/mockresponseplugin.schema.json",
    "mocksFile": "mocks.json"
  },
  "logLevel": "information",
  "port": 8000,
  "labelMode": "text"
}
```

### mocks.json

Located at `.devproxy/mocks.json`. See the actual file for the current mock definitions.

Example structure:
```json
{
  "$schema": "https://raw.githubusercontent.com/dotnet/dev-proxy/main/schemas/v2.1.0/mockresponseplugin.mocksfile.schema.json",
  "mocks": [
    {
      "request": {
        "url": "https://api.anthropic.com/v1/messages",
        "method": "POST"
      },
      "response": {
        "statusCode": 200,
        "headers": [
          { "name": "content-type", "value": "application/json" }
        ],
        "body": {
          "id": "msg_mock123",
          "type": "message",
          "role": "assistant",
          "content": [{ "type": "text", "text": "Mocked response" }],
          "model": "claude-sonnet-4-20250514",
          "stop_reason": "end_turn"
        }
      }
    }
  ]
}
```

## Running Dev Proxy

### Start Dev Proxy

Using npm scripts (recommended):
```bash
bun run test:proxy:start
# or
make test-proxy-start
```

Manual start:
```bash
cd .devproxy && devproxy
```

### Verify Proxy is Working

```bash
curl -ikx http://127.0.0.1:8000 https://api.anthropic.com/v1/messages \
  -d '{"model":"claude-sonnet-4-20250514","max_tokens":1024,"messages":[{"role":"user","content":"Hello"}]}' \
  -H "content-type: application/json" \
  -H "x-api-key: test-key" \
  -H "anthropic-version: 2023-06-01"
```

### Status and Management

```bash
# Check if Dev Proxy is running
bun run test:proxy:status
# or
make test-proxy-status

# Stop Dev Proxy
bun run test:proxy:stop
# or
make test-proxy-stop

# Restart Dev Proxy
bun run test:proxy:restart
# or
make test-proxy-restart
```

### Port Configuration

The default port is 8000. To use a different port:
```bash
DEV_PROXY_PORT=9000 bun run test:proxy:start
```

## Integration with Tests

### Test Setup

To run tests with Dev Proxy, set the following environment variables:

```bash
# Enable proxy for tests
export HTTPS_PROXY=http://127.0.0.1:8000
export HTTP_PROXY=http://127.0.0.1:8000
export NODE_USE_ENV_PROXY=1

# Trust Dev Proxy's certificate (obtain path from `devproxy --help`)
export NODE_EXTRA_CA_CERTS=~/.proxy/rootCA.pem

# Run tests
cd packages/daemon && HYPERNEO_TEST_ONLINE=true bun test ./tests/online/
```

### Using HYPERNEO_USE_DEV_PROXY Environment Variable

The `HYPERNEO_USE_DEV_PROXY=1` environment variable enables Dev Proxy integration with the test helper:

When set, the `createDaemonServer()` helper in `packages/daemon/tests/helpers/daemon-server.ts` will:

1. Start Dev Proxy before creating the daemon server
2. Set proxy environment variables automatically
3. Stop Dev Proxy when the daemon server is cleaned up

To use it:

```bash
# Run tests with Dev Proxy (the helper starts/stops proxy automatically)
cd packages/daemon && HYPERNEO_USE_DEV_PROXY=1 bun test ./tests/online/agent/agent-session-sdk.test.ts
```

This approach is cleaner than manually setting `HTTP_PROXY` and `HTTPS_PROXY`.

### Mock Mode Detection

Test files detect mock mode using either `HYPERNEO_AGENT_SDK_MOCK` or `HYPERNEO_USE_DEV_PROXY`:

```typescript
// Detect mock mode for faster timeouts (either in-process mock or Dev Proxy)
const IS_MOCK = !!(process.env.HYPERNEO_AGENT_SDK_MOCK || process.env.HYPERNEO_USE_DEV_PROXY);
```

Both modes use shorter timeouts for faster test execution.

### Backwards Compatibility

The existing `HYPERNEO_AGENT_SDK_MOCK=1` mode continues to work for backwards compatibility:

```bash
# Old approach (still works)
cd packages/daemon && HYPERNEO_AGENT_SDK_MOCK=1 bun test ./tests/online/agent/agent-session-sdk.test.ts
```

### Integration with HyperNeo Codebase

The HyperNeo daemon applies provider environment variables to `process.env` before SDK query creation via `providerService.applyEnvVarsToProcess()`. The SDK subprocess inherits these variables.

**Current provider env vars** (managed by `ProviderService`):
- `ANTHROPIC_BASE_URL` - API endpoint override
- `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` - Authentication
- `ANTHROPIC_DEFAULT_*_MODEL` - Model tier mappings
- `API_TIMEOUT_MS` - Request timeout
- `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` - Disable telemetry

**To add proxy support**, we need to ensure `HTTP_PROXY` and `HTTPS_PROXY` are:
1. Set in the test environment
2. Not filtered out by `getMergedEnvironmentVars()` (they aren't provider-specific vars)
3. Inherited by the SDK subprocess

## Certificate Management

### Getting Dev Proxy's Certificate

Dev Proxy generates a root CA certificate. Location varies by platform:

- **macOS/Linux:** `~/.proxy/rootCA.pem`
- **Windows:** `%USERPROFILE%\.proxy\rootCA.pem`

### Trusting the Certificate

**Option 1: NODE_EXTRA_CA_CERTS (Recommended)**

```bash
export NODE_EXTRA_CA_CERTS=~/.proxy/rootCA.pem
```

**Option 2: System Trust Store (macOS)**

```bash
sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain ~/.proxy/rootCA.pem
```

**Option 3: Disable TLS Verification (Development Only!)**

```bash
export NODE_TLS_REJECT_UNAUTHORIZED=0
```

⚠️ **Warning:** Option 3 disables TLS verification entirely. Only use in isolated development environments.

## Limitations and Workarounds

### 1. SDK Proxy Bug

The Claude Agent SDK has a [known issue](https://github.com/anthropics/claude-agent-sdk-typescript/issues/169) where proxy environment variables may not work with undici.

**Workaround:** Set `NODE_USE_ENV_PROXY=1` to enable Node.js native proxy support.

### 2. Streaming Responses

Dev Proxy's `MockResponsePlugin` returns static responses. For streaming (SSE) responses, you may need to:

1. Create custom mock files with SSE format
2. Use Dev Proxy's `LatencyPlugin` to simulate streaming delays
3. Consider using a custom plugin for dynamic responses

### 3. Request Matching

Dev Proxy matches requests by URL and method. For different responses based on request body:

1. Use the `body` property in mock configuration
2. Create multiple mock entries with different match conditions
3. Use Dev Proxy's dynamic mock capabilities

## Advanced Configuration

### Simulating Rate Limits

Add the `RateLimitingPlugin` to simulate API rate limits:

```json
{
  "name": "RateLimitingPlugin",
  "enabled": true,
  "pluginPath": "~appFolder/plugins/DevProxy.Plugins.dll",
  "configSection": "rateLimiting"
}
```

### Simulating Latency

Add the `LatencyPlugin` to simulate slow responses:

```json
{
  "name": "LatencyPlugin",
  "enabled": true,
  "pluginPath": "~appFolder/plugins/DevProxy.Plugins.dll",
  "configSection": "latency"
}
```

## Mock Response Files

The `.devproxy/` directory contains multiple mock files for different test scenarios:

### Available Mock Files

| File | Purpose | Scenarios Covered |
|------|---------|------------------|
| `mocks.json` | Default mock responses | Basic text response (default) |
| `mocks-basic.json` | Simple text responses | Multi-turn conversations, math, greetings |
| `mocks-tool-use.json` | Tool call scenarios | Read, Write, Glob, Grep, Bash, MCP tools |
| `mocks-errors.json` | Error responses | Rate limiting (429), server errors (500), auth errors |
| `mocks-room.json` | Multi-agent scenarios | Planner, Coder, Leader, Reviewer agents |

### Switching Mock Files

Update `devproxyrc.json` to use a different mock file:

```json
{
  "mockResponsePlugin": {
    "mocksFile": "mocks-tool-use.json"
  }
}
```

Or set the environment variable when starting Dev Proxy:

```bash
DEV_PROXY_MOCKS=mocks-tool-use.json bun run test:proxy:start
```

### Mock File Scenarios

#### mocks-basic.json

- Default text response
- Math questions (2+2, 1+1, 3+3)
- Greetings and jokes
- Room chat responses

#### mocks-tool-use.json

- `Read` tool - Read file contents
- `Write` tool - Write file contents
- `Glob` tool - List files
- `Grep` tool - Search file contents
- `Bash` tool - Execute commands
- `mcp_tool_call` - MCP server tool calls

#### mocks-errors.json

- `429` - Rate limit exceeded
- `500` - Internal server error
- `529` - Overloaded error
- `400` - Invalid request
- `401` - Authentication error
- `403` - Permission error
- `404` - Not found error
- Context length exceeded error

#### mocks-room.json

- **Chat agent** - Simple text responses for room chat
- **Planner Phase 1** - Creates plan file with Write tool
- **Planner Phase 2** - Creates tasks with MCP tool calls
- **Coder agent** - Implements task with Write tool
- **Leader agent** - Submits for review and completes tasks
- **Reviewer agent** - Reviews PRs with Bash/gh commands

### Request Matching

Dev Proxy matches requests by URL, method, and optional body fragments. More specific matches take precedence:

1. Exact URL + method + body fragment match
2. Exact URL + method match
3. Wildcard URL match

Example body fragment matching:

```json
{
  "request": {
    "url": "https://api.anthropic.com/v1/messages",
    "method": "POST",
    "bodyFragment": {
      "messages": [
        {
          "content": "What is 2+2? Answer with just the number."
        }
      ]
    }
  }
}
```

## References

- [Dev Proxy Documentation](https://learn.microsoft.com/en-us/microsoft-cloud/dev/dev-proxy/)
- [MockResponsePlugin Reference](https://learn.microsoft.com/en-us/microsoft-cloud/dev/dev-proxy/technical-reference/mockresponseplugin)
- [Simulate Anthropic API Sample](https://github.com/pnp/proxy-samples/tree/main/samples/simulate-anthropic)
- [Node.js Enterprise Network Configuration](https://nodejs.org/en/learn/http/enterprise-network-configuration)
- [SDK Proxy Issue #169](https://github.com/anthropics/claude-agent-sdk-typescript/issues/169)
