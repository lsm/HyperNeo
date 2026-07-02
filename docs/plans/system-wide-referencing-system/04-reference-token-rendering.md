# M4: Reference Token Rendering

## Milestone Goal

Implement styled mention tokens that render @ references as visually distinct, interactive elements in rendered messages. The native `<textarea>` input remains unchanged — references are shown as raw `@ref{type:id}` text in the input field (with a visual hint), and rendered as styled tokens only in sent/persisted messages.

## Scope

- `MentionToken` component for rendering styled tokens
- Integration with `SDKUserMessage` for rendering in chat
- Persistence format: `@ref{type:id}` in message content + reference metadata in `sdk_message` JSON blob
- Reference display in message history
- Deleted/moved entity handling

**Key design decision (P1-1):** The input field (`InputTextarea`) uses a native `<textarea>` element with an explicit "uncontrolled with sync" pattern designed to preserve cursor position. Converting to `contenteditable` would introduce significant cursor/IME complexity. Therefore:
- **In the input field**: References appear as raw `@ref{type:id}` text. A reference count indicator badge below/beside the textarea shows how many `@ref{}` tokens are present (e.g., "📎 2 references").
- **In sent messages**: References are rendered as styled `MentionToken` components.

---

## Tasks

### Task 4.1: Create MentionToken Component

**Description:** Create a reusable component that renders a single @ reference as a styled, interactive token.

**Subtasks:**
1. Create `packages/web/src/components/MentionToken.tsx`:
   - Props: `{ mention: ReferenceMention; metadata?: ReferenceMetadata; onClick?: () => void }`
   - Visual design:
     - Pill-shaped background with distinct color per type:
       - Task: Blue
       - Goal: Purple
       - File: Green
       - Folder: Yellow/Orange
     - Icon indicating type (use existing icons from the icon library)
     - Display text (from `metadata.displayText` or fallback to raw id)
   - Hover state: show tooltip with full details (title, status, path)
   - Click handler: trigger onClick callback (e.g., navigate to task detail, open file)
2. CSS classes — this is **new design work** (no existing mention/tag styles in the codebase):
   - Define token styles in Tailwind: `rounded-full px-2 py-0.5 text-sm inline-flex items-center gap-1`
   - Type-specific colors via CSS custom properties or Tailwind variants
   - Hover: slightly darker background + cursor pointer
3. Add keyboard accessibility:
   - Focusable when in messages
   - Enter key triggers onClick
   - ARIA label includes reference type and display text

**Acceptance Criteria:**
- MentionToken renders with type-appropriate styling and colors
- Hover shows tooltip with entity details
- Click triggers callback
- Keyboard accessible with ARIA labels
- Works with `ReferenceMetadata` from message blob or falls back gracefully
- Unit tests cover rendering, interactions, and fallback behavior

**Depends on:** Task 1.1 (types)

**Agent Type:** coder

---

### Task 4.2: Integrate Token Rendering in SDKUserMessage

**Description:** Modify `SDKUserMessage` to parse and render @ references as MentionToken components.

**Subtasks:**
1. Modify `packages/web/src/components/sdk/SDKUserMessage.tsx`:
   - Add reference parsing in message content renderer
   - Detect `@ref{type:id}` mentions using `REFERENCE_PATTERN` from shared types
   - Replace matches with `MentionToken` components
   - Load `referenceMetadata` from the `sdk_message` JSON blob for display text and status
2. Add hover preview:
   - On hover, fetch full entity data via `reference.resolve` RPC if not already loaded
   - Show popover with entity details (title, status, description excerpt)
   - Add loading state while fetching
3. Handle edge cases:
   - Plain `@` text without `{}` syntax: render as-is (no token)
   - `@ref{}` with unknown type: render as plain text with warning styling
   - Missing metadata: render token with raw id as display text
4. Performance consideration:
   - Use `React.memo` on MentionToken to prevent re-renders during scrolling
   - Lazy-load hover preview data (don't fetch all references on mount)

**Acceptance Criteria:**
- `@ref{type:id}` in user messages render as styled tokens
- Tokens show entity details on hover (lazy-loaded)
- Plain `@` text is rendered as-is
- Missing metadata falls back to raw id display
- No performance impact on message list scrolling
- Unit tests cover parsing, rendering, and fallback behavior

**Depends on:** Task 4.1

**Agent Type:** coder

---

### Task 4.3: Implement Persistence and History Display

**Description:** Ensure @ references persist correctly in message storage and display correctly in message history, including handling of deleted or moved entities.

**Subtasks:**
1. Persistence format (no schema migration needed):
   - Message content stores `@ref{type:id}` inline (human-readable, survives plain-text rendering)
   - `referenceMetadata` is embedded in the `sdk_message` JSON blob (which already stores the full SDK message as JSON):
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
   - The `referenceMetadata` field is a **HyperNeo-specific extension** at the top level of the JSON blob. The `sdk_message` column is a plain TEXT column, so extra fields are technically safe. The SDK's `SDKUserMessage` type does not include this field — it's intentionally an extension, not part of the SDK schema.
   - This approach avoids any schema migration to `sdk_messages` table
2. Update message loading in frontend:
   - When rendering historical messages, extract `referenceMetadata` from the `sdk_message` JSON blob
   - Pass metadata to `MentionToken` components
   - Fall back to plain text if metadata is missing (backward compatible with messages before this feature)
3. Handle entity state changes:
   - Task/goal deleted: show token with "deleted" styling (strikethrough or faded) and tooltip saying "This task has been deleted"
   - Task/goal status changed: show current status from metadata (the metadata captures the status at send time — for live status, hover triggers a `reference.resolve` RPC call)
   - File moved/deleted: show token with "not found" styling and tooltip saying "File not found"
4. Backward compatibility:
   - Messages before this feature have no `referenceMetadata` — render `@ref{}` as plain text
   - The `REFERENCE_PATTERN` regex simply won't match old messages (no `@ref{}` syntax)

**Acceptance Criteria:**
- References persist correctly in database (content + metadata in JSON blob)
- Historical messages display references correctly with metadata
- Deleted entities show appropriate visual state
- Status changes are detectable via hover RPC
- File moves/deletions show "not found" state
- Messages before this feature render without errors (backward compatible)
- No schema migration required
- Unit tests cover persistence format, loading, entity state changes, and backward compatibility
- Test file: `packages/daemon/tests/unit/reference-message-persistence.test.ts`

**Depends on:** Task 4.2

**Agent Type:** coder

---

## Notes

- The native `<textarea>` is NOT modified for token rendering — it shows raw `@ref{type:id}` text
- A subtle visual indicator (e.g., distinct text color for content between `@ref{` and `}`) is handled in M2 Task 2.3
- The `@ref{}` syntax was specifically chosen to not collide with markdown links
- Persistence uses the existing `sdk_message` JSON column — no schema migration needed
- Reference metadata captures entity state at send-time; live state is fetched on demand via hover
- Consider metadata expiration: if metadata is older than 24h, re-resolve on hover to get fresh state
