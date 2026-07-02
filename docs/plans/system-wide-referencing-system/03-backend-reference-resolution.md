# M3: Backend Reference Resolution

## Milestone Goal

Implement entity-specific resolvers for each reference type, integrate reference resolution into the `MessagePersistence` layer, inject resolved reference data as agent context, and handle standalone sessions gracefully.

## Scope

- Entity-specific resolvers (task, goal, file, folder)
- Message preprocessing in `MessagePersistence.persist()` (NOT the RPC handler)
- Reference extraction from `@ref{}` format in text
- Entity data fetching with path validation
- Agent context injection with resolved reference data
- Standalone session handling (graceful fallback)

**Important architectural note:** The `message.send` RPC handler in `session-handlers.ts` is a thin function that emits a `message.sendRequest` event and returns immediately. The actual message processing (persistence, command expansion, agent feeding) happens asynchronously in `SessionManager.setupEventSubscriptions()` and `MessagePersistence.persist()`. Reference resolution must happen in the `MessagePersistence` layer to integrate with this existing flow without adding latency to the RPC response.

---

## Tasks

### Task 3.1: Implement Task and Goal Resolvers

**Description:** Implement the resolution logic for task references (room tasks and space tasks) and goal references within the `ReferenceResolver` service.

**Subtasks:**
1. In `ReferenceResolver.resolveReference()`:
   - Handle `task` type references
   - Parse ID format: `@ref{task:t-42}` (room task) or `@ref{task:st-15}` (space task)
   - Fetch task from appropriate repository based on prefix (`t-` = room, `st-` = space)
   - Return `ResolvedTaskReference` with task summary:
     - `id`, `shortId`, `title`, `description`, `status`, `priority`, `progress`
     - For room tasks: `roomId`
     - For space tasks: `spaceId`, `workflowRunId`
   - Return null if session has no room/space context
2. Handle `goal` type references:
   - Parse ID format: `@ref{goal:g-7}`
   - Fetch goal from `GoalRepository`
   - Return `ResolvedGoalReference` with goal summary:
     - `id`, `shortId`, `title`, `description`, `status`, `progress`
     - `missionType`, `autonomyLevel`
     - `structuredMetrics` (for measurable missions)
   - Return null if session has no room context
3. Handle missing entities:
   - Return null if task/goal not found
   - Log warning for debugging
4. Cross-room reference prevention:
   - Task references are validated against the session's room ID
   - Goal references are validated against the session's room ID
   - References to entities from other rooms return null

**Acceptance Criteria:**
- Room tasks resolve to full task data
- Space tasks resolve to full task data
- Goals resolve to full goal data including metrics
- Missing tasks/goals return null without throwing
- Tasks/goals return null when session has no room/space context
- Cross-room references return null
- Unit tests cover both task types, goals, missing entities, and standalone sessions
- Test file: `packages/daemon/tests/unit/reference-resolver.test.ts`

**Depends on:** Task 1.5 (Reference Resolution Service)

**Agent Type:** coder

---

### Task 3.2: Implement File and Folder Resolvers

**Description:** Implement the resolution logic for file references and folder references, with path traversal prevention.

**Subtasks:**
1. File resolver in `ReferenceResolver.resolveReference()`:
   - Handle `file` type references
   - Parse path from ID (e.g., `@ref{file:src/lib/utils.ts}`)
   - **Path validation** (critical):
     - Reject paths containing `..` segments
     - Reject absolute paths starting with `/`
     - Normalize path and verify it is within workspace root
     - Reject symlinks that point outside workspace
   - Read file content via `FileManager.readFile`
   - Return `ResolvedFileReference` with:
     - `path`, `content` (truncated to 50KB at line boundary), `size`, `mtime`
     - `encoding` (utf-8 or base64 for binary)
2. Folder resolver:
   - Handle `folder` type references
   - Parse path from ID
   - Same path validation as file resolver
   - List directory contents via `FileManager.listDirectory`
   - Return `ResolvedFolderReference` with:
     - `path`, `files` (list of file info), `totalCount`
3. Handle edge cases:
   - File not found → return null
   - Permission denied → return null with log warning
   - Binary files → return base64 with content type indicator
   - Very large directories → limit listing to first 200 entries

**Acceptance Criteria:**
- Files resolve to content (truncated for large files, at line boundaries)
- Folders resolve to file listing (limited to 200 entries)
- Path traversal with `..` is rejected
- Absolute paths outside workspace are rejected
- Symlinks pointing outside workspace are rejected
- Missing files/folders return null
- File/folder resolution works regardless of room/space context
- Unit tests cover all resolvers and path traversal prevention
- Test file: `packages/daemon/tests/unit/reference-resolver.test.ts`

**Depends on:** Task 1.5

**Agent Type:** coder

---

### Task 3.3: Implement Message Preprocessing in MessagePersistence

**Description:** Integrate reference resolution into the `MessagePersistence.persist()` flow to resolve @ references before persisting and sending to the agent.

**Subtasks:**
1. Modify `packages/daemon/src/lib/session/message-persistence.ts`:
   - Add a `preprocessReferences(text: string, context: ResolutionContext): Promise<PreprocessedMessage>` step
   - Call `ReferenceResolver.extractReferences()` to find `@ref{}` mentions in the text
   - If references found, call `resolveAllReferences()` with session context
   - Build `referenceMetadata` map from resolved references
   - Return original text (with `@ref{}` mentions) + metadata
2. Integration point:
   - In `persist()`, call `preprocessReferences()` before persisting the SDK message
   - Embed `referenceMetadata` into the `sdk_message` JSON blob alongside content
   - The `sdk_message` column is a plain TEXT column — adding `referenceMetadata` as a HyperNeo-specific extension field is safe (extra fields are ignored by the SDK type but preserved by SQLite)
   - The `@ref{}` text stays in the message content (readable in raw form)
3. Handle errors gracefully:
   - If resolution fails for some references, keep them as-is in text
   - Log warnings for individual resolution failures
   - Never block message sending due to reference resolution errors
4. Session context extraction:
   - Get `roomId` and `spaceId` from the session metadata
   - Get `workspacePath` from the daemon config
   - Build `ResolutionContext` for the resolver

**Acceptance Criteria:**
- @ references in user messages are extracted and resolved during persistence
- Original text with `@ref{}` mentions is preserved in message content
- Reference metadata is embedded in the `sdk_message` JSON blob
- Resolution errors are handled gracefully (unresolved references kept as-is)
- Resolution happens in `MessagePersistence.persist()`, not in the RPC handler
- Messages without references are unaffected (no extra processing)
- Unit tests cover preprocessing, metadata embedding, and error handling
- Test file: `packages/daemon/tests/unit/reference-message-persistence.test.ts`

**Depends on:** Task 3.1, Task 3.2 (resolvers must exist before preprocessing can call them)

**Agent Type:** coder

---

### Task 3.4: Implement Agent Context Injection

**Description:** Create the mechanism to inject resolved reference data into the agent's context as structured data.

**Subtasks:**
1. Create `packages/daemon/src/lib/agent/reference-context-builder.ts`:
   - `buildReferenceContext(references: Record<string, ResolvedReference>): string`
   - Generates markdown-formatted context block for agent
   - Format:
     ```markdown
     ## Referenced Entities

     ### Task: t-42
     **Title:** Implement user authentication
     **Status:** in_progress
     **Priority:** high
     **Progress:** 60%
     **Description:** Add OAuth2 authentication flow...

     ### Goal: g-7
     **Title:** Q1 Revenue Target
     **Type:** measurable
     **Progress:** 75%
     **Metrics:** Revenue: $750,000 / $1,000,000

     ### File: src/lib/utils.ts
     ```
     [file content here - truncated]
     ```
     ```
2. Integrate with message persistence flow:
   - After resolving references, build context block
   - Prepend to user message content as a separate context section
   - Clearly delimited from user message text
3. Handle large reference sets:
   - Limit total context size (e.g., 200KB)
   - Prioritize task > goal > file > folder when truncating
   - Log warning when context is truncated
4. Handle empty reference sets:
   - If no references resolved, skip context injection entirely

**Acceptance Criteria:**
- Resolved references are formatted as readable markdown context
- Context is prepended to user message for agent
- Large contexts are truncated gracefully with priority ordering
- Context is clearly delimited from user message
- No context injection when no references exist
- Unit tests cover context building, truncation, and priority ordering
- Test file: `packages/daemon/tests/unit/reference-context-builder.test.ts`

**Depends on:** Task 3.3

**Agent Type:** coder

---

## Notes

- Resolution happens in `MessagePersistence.persist()` to integrate with the existing async event flow
- Failed resolutions should not block message sending — unresolved references remain as `@ref{}` text
- The agent context format is markdown for readability and compatibility
- Consider caching resolved references for the duration of a session to avoid repeated lookups
- File content truncation truncates at line boundaries when possible
- Path traversal prevention is enforced at the resolver level (Tasks 3.1, 3.2) — every file/folder access validates the path
