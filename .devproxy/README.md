# Dev Proxy Mock Files

This directory contains mock response files for the HyperNeo test suite. These files are used by Dev Proxy to simulate Anthropic API responses without making real API calls.

## Quick Start

```bash
# Run one online test with Dev Proxy (helper auto starts/stops proxy)
cd packages/daemon && HYPERNEO_USE_DEV_PROXY=1 bun test ./tests/online/convo/multiturn-conversation.test.ts

# Or run all online tests
cd packages/daemon && HYPERNEO_USE_DEV_PROXY=1 bun test ./tests/online/
```

### Strict Safety in Dev Proxy Mode

When `HYPERNEO_USE_DEV_PROXY=1` is enabled via the online test helper:

- `CLAUDE_CODE_OAUTH_TOKEN` is cleared
- `ANTHROPIC_AUTH_TOKEN` is cleared
- `ANTHROPIC_API_KEY` is replaced with a dummy test key
- Tests fail fast if Dev Proxy is unavailable

This prevents accidental real Anthropic credential usage during mocked runs.

### Verify Requests Hit Dev Proxy

After a test run, either:

```bash
# Persist logs to .devproxy/devproxy.log during helper-managed stop
(cd packages/daemon && HYPERNEO_DEV_PROXY_CAPTURE_LOGS=1 HYPERNEO_USE_DEV_PROXY=1 bun test ./tests/online/convo/multiturn-conversation.test.ts)
tail -n 120 .devproxy/devproxy.log

# Or read directly from devproxy
devproxy logs --lines 120 --output text
```

Expected signal of a properly mocked request:

- `req ... POST http://127.0.0.1:8000/v1/messages?beta=true`
- `mock ... MockResponsePlugin: 200 ...`

If you see `pass ... Passed through`, the request did not match a mock.

## CI: Bun Mock Server

GitHub Actions does not install the .NET Dev Proxy. The `Setup Dev Proxy` action starts `scripts/dev-proxy-stub.ts`, a dependency-free Bun HTTP server that loads `devproxyrc.json` and the mock files from this directory and applies the same matching rules (method + exact or `*`-wildcard URL + case-insensitive `bodyFragment` substring, first match wins). Two deliberate differences: unmatched requests get an immediate 502 instead of a pass-through, and the admin endpoint `GET :8897/proxy` reports the config path so the test helper's external-proxy detection works unchanged. Run it locally the same way:

```bash
bun scripts/dev-proxy-stub.ts --port 8000 --config-file .devproxy/devproxyrc.json
```

## Mock Files

| File | Description | Use Case |
|------|-------------|----------|
| `mocks.json` | Default mock responses | General testing |
| `mocks-basic.json` | Simple text responses | Basic conversation tests |
| `mocks-tool-use.json` | Tool call scenarios | Tool execution tests |
| `mocks-errors.json` | Error responses | Error handling tests |
| `mocks-room.json` | Multi-agent scenarios | Room workflow tests |

## Switching Mock Files

Edit `devproxyrc.json`:

```json
{
  "mockResponsePlugin": {
    "mocksFile": "mocks-tool-use.json"
  }
}
```

Then restart Dev Proxy:

```bash
bun run test:proxy:restart
```

## Scenario Coverage

### mocks-basic.json

| Trigger | Response |
|---------|----------|
| Default | Generic greeting message |
| "What is 2+2?..." | "4" |
| "What is 1+1?..." | "2" |
| "What is 3+3?..." | "6" |
| "Say hello" | Greeting response |
| "Tell me a joke" | Programmer joke |
| "room ok" | Room chat acknowledgment |

### mocks-tool-use.json

| Trigger | Tool | Action |
|---------|------|--------|
| "Read the file test.txt" | Read | File read operation |
| "Write a file called output.txt..." | Write | File write operation |
| "List files in the current directory" | Glob | File listing |
| "Search for TODO in all files" | Grep | Content search |
| "Run the command echo hello" | Bash | Command execution |
| "What is git status?" | Bash | Git status check |
| "Call the MCP tool to create a task" | mcp_tool_call | MCP tool invocation |

### mocks-errors.json

| Trigger | Status | Error Type |
|---------|--------|------------|
| "trigger rate limit" | 429 | rate_limit_error |
| "trigger server error" | 500 | api_error |
| "trigger overloaded error" | 529 | overloaded_error |
| "trigger invalid request" | 400 | invalid_request_error |
| "trigger authentication error" | 401 | authentication_error |
| "trigger permission error" | 403 | permission_error |
| "trigger not found error" | 404 | not_found_error |
| "trigger context length error" | 400 | invalid_request_error (context) |
| "trigger tool error" | 200 | Tool error response |
| "trigger max turns error" | 200 | Max turns message |

### mocks-room.json

| Agent | Scenario | Tools Used |
|-------|----------|------------|
| Chat | Simple text response | None |
| Planner | Phase 1 - Create plan | Write |
| Planner | Phase 2 - Create tasks | mcp_tool_call |
| Coder | Implement task | Write |
| Leader | Submit for review | mcp_tool_call (submit_for_review) |
| Leader | Complete task | mcp_tool_call (complete_task) |
| Reviewer | Review PR | Bash (gh pr view) |

## Request Matching Priority

Dev Proxy matches requests in this order:

1. **Exact match** - URL + method + body fragment
2. **URL match** - URL + method only
3. **Wildcard match** - URL pattern with wildcards

More specific matches take precedence over general ones.

## Adding New Mocks

1. Choose the appropriate mock file (or create a new one)
2. Add a new mock entry with:
   - `request.url` - The API endpoint
   - `request.method` - HTTP method (usually POST)
   - `request.bodyFragment` - Optional request body matcher
   - `response.statusCode` - HTTP status code
   - `response.headers` - Response headers
   - `response.body` - Anthropic API response format

Example:

```json
{
  "request": {
    "url": "http://127.0.0.1:8000/v1/messages?beta=true",
    "method": "POST",
    "bodyFragment": {
      "messages": [
        {
          "content": "your trigger phrase here"
        }
      ]
    }
  },
  "response": {
    "statusCode": 200,
    "headers": [
      {
        "name": "content-type",
        "value": "application/json"
      }
    ],
    "body": {
      "id": "msg_custom_001",
      "type": "message",
      "role": "assistant",
      "content": [
        {
          "type": "text",
          "text": "Your response text here"
        }
      ],
      "model": "claude-sonnet-4-20250514",
      "stop_reason": "end_turn",
      "stop_sequence": null,
      "usage": {
        "input_tokens": 10,
        "output_tokens": 10,
        "cache_creation_input_tokens": 0,
        "cache_read_input_tokens": 0,
        "service_tier": "standard"
      }
    }
  }
}
```

## Documentation

For more details, see [docs/dev-proxy-integration.md](../docs/dev-proxy-integration.md).
