# GitHub Copilot CLI Message Format Mapping

**Date:** 2026-03-14

---

## Overview

This document maps HyperNeo SDK message types to/from GitHub Copilot CLI NDJSON format.

---

## Outbound: HyperNeo SDK → Copilot CLI

The Copilot CLI accepts a prompt string via `-p <text>`. Complex conversation context
(system prompt, multi-turn history) must be embedded in the prompt string.

### SDKUserMessage → Copilot Prompt

**Input format:**
```typescript
type SDKUserMessage = {
  type: 'user';
  message: {
    role: 'user';
    content: string | ContentBlock[];
  };
  session_id: string;
  // ...
};
```

**Extraction logic:**
```typescript
function extractPromptText(message: SDKUserMessage): string {
  const { content } = message.message;
  if (typeof content === 'string') return content;

  // Array content: extract text blocks, ignore tool_result blocks
  return content
    .filter(b => b.type === 'text')
    .map(b => (b as TextBlock).text)
    .join('\n');
}
```

**Image handling:**
- The Copilot CLI does not support inline base64 images via stdin/NDJSON in v1.0.2.
- Images must be passed as file paths. Future versions may support multimodal input
  via the ACP protocol.

**Tool results (multi-turn):**
- In JSONL mode, tool result messages are NOT sent back to Copilot. The CLI handles
  all tool execution autonomously.
- For ACP mode, tool permission responses flow back via JSON-RPC.

### SDKSystemMessage → System Context

The Copilot CLI uses `AGENTS.md` (initialized by `copilot init`) as the persistent
system prompt. For per-session system prompts, they can be prepended to the `-p` prompt:

```bash
copilot -p "[System: You are a code reviewer. Focus on security.]\n\nReview this PR..."
```

**Note:** The Copilot CLI has its own built-in system prompt for its agentic behavior.
User-provided system prompts are best treated as prefix context.

### Tool Definitions → Not Applicable

The legacy callback-based adapter converted HyperNeo `ToolDefinition[]` into an intermediate
tool format and executed callbacks inside HyperNeo. The **Copilot CLI does not accept external
tool definitions**. Instead:
- The CLI has its own built-in tool set (bash, file ops, GitHub API)
- Tool execution is automatic with `--allow-all`
- HyperNeo tools are not invocable by Copilot CLI

This is the key architectural difference:
| Approach | Tool Execution |
|----------|---------------|
| Callback-based adapter | HyperNeo provides tools + executes callbacks |
| Copilot CLI | CLI has built-in tools, executes autonomously |

---

## Inbound: Copilot CLI → HyperNeo SDK

### NDJSON Stream → SDKMessages

The Copilot CLI emits one JSON object per line. Each object has shape:
```typescript
interface CopilotJsonlEvent {
  type: string;
  data: Record<string, unknown>;
  id: string;
  timestamp: string;
  parentId?: string;
  ephemeral?: boolean;
}
```

### Event-by-Event Mapping

#### `user.message` → (ignored)
The CLI echoes back the input prompt. Ignored — we already have it.

#### `assistant.turn_start` → (ignored)
Signals start of a response turn. No HyperNeo equivalent needed.

#### `assistant.reasoning_delta` (ephemeral) → (ignored)
Streaming reasoning tokens. Could be mapped to `stream_event` with `thinking_delta`
type in future. Currently ignored.

#### `assistant.message_delta` (ephemeral) → `SDKPartialAssistantMessage`
Streaming text tokens. Maps to `stream_event`:

```typescript
// Copilot event:
{ type: 'assistant.message_delta', data: { delta: 'Hello ' }, ephemeral: true }

// HyperNeo SDK:
{
  type: 'stream_event',
  event: {
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'text_delta', text: 'Hello ' }
  },
  parent_tool_use_id: null,
  uuid: generateUUID(),
  session_id: '...'
}
```

#### `assistant.message` → `SDKAssistantMessage`
Final complete message. Maps to assistant message:

```typescript
// Copilot event:
{
  type: 'assistant.message',
  data: {
    content: [{ type: 'text', text: 'Here is the solution...' }],
    toolRequests: [
      { id: 'tool_abc', name: 'bash', arguments: { command: 'ls -la' } }
    ],
    reasoningText: '<thinking>Let me analyze this...</thinking>'
  }
}

// HyperNeo SDK:
{
  type: 'assistant',
  message: {
    role: 'assistant',
    content: [
      { type: 'text', text: 'Here is the solution...' },
      { type: 'tool_use', id: 'tool_abc', name: 'bash', input: { command: 'ls -la' } }
    ]
  },
  parent_tool_use_id: null,
  uuid: generateUUID(),
  session_id: '...'
}
```

**Note:** `toolRequests` in the Copilot output map to `tool_use` blocks. However, since
the CLI executes tools autonomously, these are informational — HyperNeo cannot intercept them.

#### `assistant.reasoning` → (optional SDKAssistantMessage)
Complete reasoning block. Can be optionally prepended to the assistant message as a
thinking block or ignored.

#### `assistant.turn_end` → (ignored)
Turn completion signal. No HyperNeo equivalent needed.

#### `result` → `SDKResultMessage`
Final result. Maps to success or error based on `exitCode`:

```typescript
// Copilot event:
{
  type: 'result',
  data: {
    sessionId: 'session_abc123',
    exitCode: 0,
    usage: {
      premiumRequests: 1,
      totalApiDurationMs: 5234
    }
  }
}

// HyperNeo SDK (success):
{
  type: 'result',
  subtype: 'success',
  is_error: false,
  duration_ms: 5234,
  duration_api_ms: 5234,
  num_turns: 1,
  result: '<accumulated text>',
  stop_reason: 'end_turn',
  total_cost_usd: 0,        // Cost not available from CLI
  usage: { input_tokens: 0, output_tokens: 0, ... },
  modelUsage: {},
  permission_denials: [],
  uuid: generateUUID(),
  session_id: '...'
}

// HyperNeo SDK (error, exitCode != 0):
{
  type: 'result',
  subtype: 'error_during_execution',
  is_error: true,
  errors: ['Copilot CLI exited with code 1: <stderr>'],
  ...
}
```

**Usage reporting limitation:** The Copilot CLI only reports `premiumRequests` and
`totalApiDurationMs`. Token counts and USD cost are NOT available. HyperNeo usage fields
are zeroed.

---

## Session / Conversation ID Handling

The `result` event returns a `sessionId` that can be used to resume the conversation:

```bash
# First turn
copilot -p "initial prompt" --output-format json --silent
# → result.data.sessionId = "session_abc123"

# Second turn (continues the conversation)
copilot -p "follow-up prompt" --output-format json --silent --resume session_abc123
```

**HyperNeo integration:** The adapter can store the `sessionId` from each result and
pass it to subsequent invocations. However, since HyperNeo's `createQuery()` is called
once per user message (not per session), session resumption requires:
1. Storing `sessionId` in `ProviderQueryContext` or provider state
2. Passing it via `config.resumeSessionId` to the adapter

**Current POC approach:** No session resumption — each query starts a fresh Copilot session.
The Copilot CLI's autonomous multi-turn tool execution handles complexity within a single
invocation.

---

## Multimodal Input

| Content Type | Legacy Callback Adapter | Copilot CLI Adapter |
|-------------|--------------------------|---------------------|
| Text | ✅ | ✅ |
| Images (base64) | ✅ (via legacy image content mapping) | ❌ (v1.0.2, planned for ACP) |
| File references | ❌ | ✅ (CLI reads files directly) |
| Screenshots | ✅ (converted to base64) | ❌ (v1.0.2) |

---

## Context Window Management

The Copilot CLI manages its own context window internally. Key differences:
- **Legacy callback adapter:** HyperNeo passes full conversation history and the adapter manages it
- **Copilot CLI:** Context is maintained server-side in the Copilot session. The CLI
  handles `/compact` internally if context fills up.

For initial invocations, the full system prompt can be prepended to the prompt string.
Context window is NOT a concern HyperNeo needs to manage when using the CLI.

---

## Full Event Flow Example

```
[HyperNeo] → spawn: copilot -p "Write a fibonacci function" --output-format json --silent
                          --allow-all --model claude-sonnet-4.6 --cwd /workspace
  ↓ stdout NDJSON stream:
{"type":"user.message","data":{"content":"Write a fibonacci function"},...}
{"type":"assistant.turn_start","data":{},...}
{"type":"assistant.message_delta","data":{"delta":"Here"},"ephemeral":true,...}
{"type":"assistant.message_delta","data":{"delta":" is"},"ephemeral":true,...}
{"type":"assistant.message_delta","data":{"delta":" a fibonacci"},"ephemeral":true,...}
  [... more deltas ...]
{"type":"assistant.message","data":{"content":[{"type":"text","text":"Here is a fibonacci..."}],...},...}
{"type":"assistant.turn_end","data":{},...}
{"type":"result","data":{"sessionId":"s_abc","exitCode":0,"usage":{...}},...}

[HyperNeo yields]:
  1. SDKSystemMessage (init)
  2. SDKPartialAssistantMessage (stream_event, delta="Here")
  3. SDKPartialAssistantMessage (stream_event, delta=" is")
  ... (one per message_delta)
  4. SDKAssistantMessage (final complete message)
  5. SDKResultMessage (success)
```
