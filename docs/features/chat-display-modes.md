# Chat Display Modes

Status: proposed design, 2026-10-06. Follows the 16 KB tool-output cap (#5775).

## Problem

A chat shows every tool call with its input and output and every thinking
block. Long agent sessions are mostly tool traffic: on tts, one session holds
233k messages, and 654 MB of its stored messages are tool output. Reading what
the agent actually said means scrolling past screens of tool cards, and the
browser receives and renders all of it.

## Modes

Three modes, switchable per session:

| | Full | Compact | Minimal |
| --- | --- | --- | --- |
| Your messages | shown | shown | shown |
| Assistant text | shown | shown | shown |
| Tool call | card with input and output | one row: icon, title, status | hidden, counted in the turn status |
| Thinking | expandable block | one row: "Thought for 8s" | hidden |
| Subagent (Task/Agent) | nested block | one row: description and status | hidden, counted |
| Tool error | red card | red row with the error's first line | red line under the turn |
| Question for you, permission prompt | shown | shown | shown |
| Rate limit, auth, errors that stop the turn | shown | shown | shown |
| System notices (compaction, hooks, retries) | shown | one row | hidden |
| Turn result (cost, usage) | shown | collapsed | hidden |
| While running | live cards | live rows | one "Working…" line |

Anything that needs you (a question, a permission prompt, an error that stopped
the turn) shows in every mode. A mode only hides activity.

### Full

Today's view, unchanged.

### Compact

Each tool call becomes a single row:

```
  ▸ Read   src/lib/router.ts                     ✓ 0.2s
  ▸ Bash   bun test router.test.ts               ✓ 14s
  ▸ Edit   src/lib/router.ts                     ✓
  ▸ Bash   gh pr view 5739                       ✗ exit 1: no pull request found
  ◦ Thought for 8s
  ▸ Grep   "classifyNeoAsk" in src               ⟳ running
```

- The title comes from the existing `ToolSummary` (file path, command,
  pattern, description). Status is a spinner, a check with duration, or a cross
  with the first line of the error.
- A run of more than five consecutive tool rows folds to
  `12 tool calls · 1 failed · show all`.
- Clicking a row opens that one call as a full card in place (a peek), loading
  the full input and output on demand. Other rows stay compact.
- Thinking shows "Thinking… 6s" while live, then "Thought for 8s". Clicking
  shows the text.

### Minimal

Only the conversation and one status line per turn:

```
  You       Is PR 5739 merged?

  ◦ Working · Bash gh pr view 5739 · 12s

  Assistant Yes, merged 2 hours ago by lsm.
  ─ Worked for 41s · 6 tool calls · 1 failed  (show steps)
```

- While the turn runs, the status line shows the current action (from the
  existing `getCurrentAction`) and the elapsed time.
- When the turn ends, the line becomes a summary: duration, tool calls, failures.
  "Show steps" expands that one turn into Compact.
- Neo's conversation view already works this way (`neo/NeoConversation.tsx`,
  `neo/processing-activity.ts`). Minimal reuses its pieces.

## The switch

- A segmented control in the chat header (`components/ChatHeader.tsx`, next to
  the conversation info button): Full · Compact · Minimal. On narrow screens it
  moves into the header menu (`ChatHeaderMenu.tsx`). Shortcut: cycle with
  `⌘/Ctrl + Shift + M`.
- **Default mode:** a global setting in Settings → General, stored like
  `autoScroll` (`GlobalSettings`).
- **Per-session override:** stored in `SessionConfig`, saved with
  `updateSession`, the same way `ChatContainer` already saves `autoScroll`. A
  session you switched stays in its mode across devices and reloads.
- Suggested default: Compact. Full stays one click away.

## Implementation

### 1. Turns on the client

The chat list is flat today: `ChatContainer` maps messages straight to
`SDKMessageRenderer`. Compact folding and Minimal summaries both need turns.

Add `lib/chat-turns.ts`, a pure function:

```ts
buildChatTurns(messages, maps) => ChatTurn[]

interface ChatTurn {
  user: SDKMessage | null;
  items: TurnItem[];
  replies: SDKMessage[];
  status: 'running' | 'done' | 'failed' | 'waiting';
  startedAt: number;
  endedAt: number | null;
  toolCount: number;
  errorCount: number;
}
```

`TurnItem` is a tool call, a thinking block, a subagent, a notice or a
needs-you item. A turn starts at a user message and ends at its `result`
message. Durations come from row timestamps (`mapMessageRow` already sets
`timestamp`). Tool status comes from the existing maps (`toolResultsMap`,
`taskNotificationsMap`, `runningToolUseIds`). Neo's `completedConversation` and
the Space thread's `MinimalThreadFeed` already build turns. This function
replaces both with one tested implementation.

### 2. Rendering

- **Full:** today's path, untouched.
- **Compact:** `ToolRow` reuses `ToolResultCard`'s header (icon, `ToolSummary`,
  status) with `disableExpand`. A click swaps in the full card and loads full
  content through `message.sdkMessage` (#5775). `ThinkingStatus` replaces
  `ThinkingBlock` with a one-line status. `ToolRun` folds runs longer than five.
- **Minimal:** `TurnStatusLine` renders the live action or the finished summary.
  "Show steps" renders that turn in Compact.
- Needs-you items (`QuestionPrompt`, permission requests, rate limit and auth
  cards) render with their existing components in every mode.

### 3. Fewer bytes from the server (second step)

Compact and Minimal never display tool inputs or outputs, so the daemon need
not send them. Add a named query `messages.bySession.compact`, sharing the SQL
of `messages.bySession`, whose `mapRow` thins each row:

- `tool_use`: keep `id`, `name`, `parent_tool_use_id` and the fields
  `ToolSummary` reads (`file_path`, `path`, `command`, `pattern`,
  `description`, `url`, `query`); drop the rest. Keep `TodoWrite` and
  `AskUserQuestion` inputs whole, because the session inspector and resolved
  questions read them.
- `tool_result`: keep `tool_use_id`, `is_error` and the first line of an error;
  drop the content. Dropping the whole block would make the row look like an
  empty user bubble (`isToolResultUserMessage`).
- `tool_use_result`: drop.
- `thinking`: replace with a placeholder that keeps its length, so
  `hasRenderableThinking` still renders the status line.

`message.sdkMessages` paging takes the same mode. Switching to Full
re-subscribes to `messages.bySession`, and a peek fetches one message in full.
This keeps a long session's snapshot to tens of KB instead of megabytes.

### 4. Other surfaces

Every chat surface mounts `ChatContainer` (`SpaceAgentChat`, `SpaceIsland`,
`AgentOverlayChat`, `NeoSessionPane`, `MainContent`), so they inherit the modes.
The Space task thread already offers compact and minimal views from its own
queries. It adopts the same switch and the same names, and its existing `full`
variant becomes the third mode. Neo's conversation stays Minimal by design.

## Rollout

One PR each:

1. `buildChatTurns` with tests, built from fixtures of real sessions; wire Neo
   and `MinimalThreadFeed` to it.
2. Mode setting and per-session override, and the header switch, still
   rendering Full.
3. Compact rendering: `ToolRow`, `ThinkingStatus`, `ToolRun`, peek.
4. Minimal rendering: `TurnStatusLine`, show steps.
5. Server thinning: `messages.bySession.compact` and paging by mode.
6. Space task thread on the shared switch.

## Open questions

- Default mode for new sessions: Compact (suggested) or Full.
- Should Minimal show a subagent's own final reply, or only count it?
- Should a turn that failed open in Compact automatically, in Minimal?
