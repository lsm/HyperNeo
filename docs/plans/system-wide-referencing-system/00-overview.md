# System-Wide @ Referencing System

## Goal Summary

Design and implement a comprehensive @ referencing system that allows users to reference tasks, goals, files, and folders from the chat input in the application. When a user types @, an autocomplete menu appears similar to the / command experience, enabling semantic resolution of references that the agent can understand and act upon.

**Scope clarification:** The @ trigger applies to the main `MessageInput` component used in Room, Space, and standalone sessions. It does not apply to non-chat input fields (task title editing, goal description editing, etc.) — those are out of scope.

## High-Level Approach

1. **Reuse existing slash command infrastructure** - The autocomplete menu pattern from `useCommandAutocomplete` and `CommandAutocomplete` will serve as the foundation.
2. **Support multiple entity types** - Tasks (room tasks, space tasks), Goals/Missions, Files, and Folders.
3. **Semantic resolution** - The backend parses @ references from input text and resolves them to actual entity data before sending to the agent. Resolution happens in the `MessagePersistence` layer, not the RPC handler.
4. **Persistence as structured mentions** - @ references are stored in message content using a dedicated `@ref{}` delimiter that avoids collision with markdown, embedded in the `sdk_message` JSON blob alongside reference metadata.
5. **Context-aware fallback** - Sessions without room/space context gracefully degrade to file/folder-only references.

## Milestones

1. **M1: Core Types and RPC Infrastructure** - Define shared types for references, create backend RPC handlers, add workspace file index with caching.
2. **M2: Frontend Autocomplete Menu** - Implement `useReferenceAutocomplete` hook and `ReferenceAutocomplete` component, extending the slash command pattern.
3. **M3: Backend Reference Resolution** - Implement entity resolvers, message preprocessing in MessagePersistence, and agent context injection.
4. **M4: Reference Token Rendering** - Implement styled mention tokens in rendered messages; keep raw text in native textarea with a reference count indicator badge.
5. **M5: E2E Testing** - Comprehensive Playwright tests covering all entity types and edge cases, with UI/E2E helpers for room entity setup.

## Cross-Milestone Dependencies

```
M1 (Types/RPC) ──┬──> M2 (Frontend Menu) ──> M4 (Token Rendering)
                 │
                 └──> M3 (Backend Resolution) ──> M5 (E2E Tests)
                                                    ^
                                                    │
                          M2 + M3 + M4 ──────────────┘
```

**Key sequencing decisions:**

- M1 must complete first as it provides types used by both frontend and backend.
- M2 and M3 can proceed in parallel after M1.
- M4 depends on M2 for the autocomplete selection mechanism.
- M5 requires M2, M3, and M4 to be complete for full integration testing.

## Total Estimated Task Count

~21 tasks across 5 milestones:
- M1: 5 tasks (types, RPC handlers, reference resolution service, file index/caching)
- M2: 5 tasks (hook, component, integration with InputTextarea, keyboard navigation, mobile UX)
- M3: 4 tasks (entity resolvers, message preprocessing, agent context injection, standalone session handling)
- M4: 3 tasks (mention token component, message rendering integration, persistence format)
- M5: 4 tasks (E2E helpers, basic autocomplete E2E, entity resolution E2E, edge cases E2E)

## Reference Syntax Design

```
@task-t-42        -> Reference to room task with shortId "t-42"
@task-st-15       -> Reference to space task with shortId "st-15"
@goal-g-7         -> Reference to goal/mission with shortId "g-7"
@file:src/lib.ts  -> Reference to file at path "src/lib.ts"
@folder:src/lib   -> Reference to folder at path "src/lib"
```

**Storage format in message content:**

```
@ref{task:t-42}        -> Dedicated delimiter, no collision with markdown
@ref{goal:g-7}         -> Preserves entity type and ID for backend parsing
@ref{file:src/lib.ts}  -> File path reference
```

The `@ref{}` syntax was chosen over markdown-style links (`[@:type:id](text)`) because:
- It cannot be confused with markdown link syntax
- The regex pattern is unambiguous: `/@ref\{([^}:]+):([^}]+)\}/`
- It remains human-readable in raw message content
- It avoids false-positive matching of any standard markdown constructs

**Reference metadata** is stored alongside the message in the `sdk_message` JSON blob as a HyperNeo-specific extension field (no schema migration needed — the `sdk_message` column is plain TEXT, so extra fields are preserved by SQLite):
```json
{
  "role": "user",
  "content": "Fix @ref{task:t-42} and update @ref{file:src/lib.ts}",
  "referenceMetadata": {
    "task:t-42": { "type": "task", "id": "...", "displayText": "t-42: Fix auth bug", "status": "in_progress" },
    "file:src/lib.ts": { "type": "file", "id": "src/lib.ts", "displayText": "src/lib.ts" }
  }
}
```
Note: `referenceMetadata` is intentionally not part of the SDK's `SDKUserMessage` type — it's a HyperNeo extension stored at the top level of the JSON blob.

## Key Technical Decisions

1. **Short IDs for entities** - Use existing `shortId` fields on tasks and goals for human-readable references (e.g., `t-42`, `g-7`).
2. **Fuzzy search with workspace file index** - Implement a cached workspace file tree with polling-based refresh (10s default) for cache invalidation, enabling fast fuzzy matching without recursive directory listing on every query. Files matching `.gitignore` patterns are filtered out.
3. **Context-aware resolution with graceful fallback** - Backend resolves references based on current session context (room ID, space ID, workspace path). Standalone sessions without room/space context only support file/folder references.
4. **Resolution in MessagePersistence layer** - Reference resolution happens in `MessagePersistence.persist()` (or a preprocessing step before it), not in the thin `message.send` RPC handler. This integrates with the existing persistence and event flow without adding RPC latency.
5. **Composability with slash commands** - @ references work anywhere in the message, including after slash commands (e.g., `/agent @task-t-42 fix the bug`).
6. **Agent context injection** - Resolved reference data is injected as structured context before the user message in the SDK message payload.
7. **Native textarea with raw text** - The input field remains a native `<textarea>` (preserving cursor/IME stability). @ references are stored as raw `@ref{}` text in the input, and rendered as styled tokens only in sent messages. A reference count indicator badge below/beside the textarea shows how many references are active.
8. **Access control** - File/folder references are restricted to the workspace root path. Path traversal (`..`, absolute paths, paths outside workspace) is rejected. Task/goal references are scoped to the session's room/space context — cross-room references are not supported.
9. **ReferenceType as union type** - Uses `'task' | 'goal' | 'file' | 'folder'` (TypeScript union), consistent with existing codebase patterns (e.g., `SessionType`).

## Standalone Session Handling

Sessions without room/space context are supported with graceful degradation:
- **File/folder search**: Works normally, scoped to workspace root
- **Task/goal search**: Returns empty results (no tasks/goals exist outside rooms/spaces)
- **@ trigger**: Shows autocomplete with only file/folder results
- **Resolution**: File/folder references resolve normally; task/goal references return null (treated as plain text)
- **UI indicator**: If in standalone session, autocomplete menu header says "Files & Folders" instead of "References"

## Affected Areas

### Frontend (packages/web)
- `src/hooks/useReferenceAutocomplete.ts` (new)
- `src/hooks/useCommandAutocomplete.ts` (reference)
- `src/components/ReferenceAutocomplete.tsx` (new)
- `src/components/CommandAutocomplete.tsx` (reference)
- `src/components/InputTextarea.tsx` (minor modify — add visual hint for @ref tokens)
- `src/components/MessageInput.tsx` (modify)
- `src/components/MentionToken.tsx` (new)
- `src/components/sdk/SDKUserMessage.tsx` (modify for rendering)
- `src/lib/reference-store.ts` (new - for entity search)

### Backend (packages/daemon)
- `src/lib/rpc-handlers/reference-handlers.ts` (new)
- `src/lib/agent/reference-resolver.ts` (new)
- `src/lib/agent/reference-context-builder.ts` (new)
- `src/lib/session/message-persistence.ts` (modify — add reference preprocessing)
- `src/lib/file-index.ts` (new — workspace file tree with caching)

### Shared (packages/shared)
- `src/types/reference.ts` (new)
- `src/mod.ts` (add `export * from './types/reference.ts'`)

### E2E Tests (packages/e2e)
- `tests/features/reference-autocomplete.e2e.ts` (new)
- `tests/helpers/reference-helpers.ts` (new)
- `tests/helpers/room-helpers.ts` (new — room/task/goal UI helpers)
