# Milestone 5: Web Component Tests (Complex)

## Milestone Goal

Write tests for complex, signal-coupled Preact components. These components read from and
write to Preact Signals, making them harder to test in isolation. The key pattern is to
wrap the component under test in a fresh signal context per test, configure the signal's
initial value, render, act, then assert.

## Testing Pattern: Signal Injection via Context Provider

Because Preact Signals are module-level singletons, tests that mutate signal state must
either:

1. **Mock the signal module**: Use `vi.mock('../../lib/signals', ...)` to replace the signal
   with a fresh `signal(initialValue)` per test file. This is the preferred approach when
   the component only reads from signals.
2. **Mutate the signal directly**: Import the same signal the component uses, set `.value`
   before/after render, and use `waitFor()` for async propagation effects.

For components that call `connectionManager` or dispatch RPC calls, stub those at the
module level with `vi.mock()`.

Always call `cleanup()` in `afterEach` to prevent signal and DOM leaks between tests.

Example skeleton:
```tsx
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen, waitFor } from '@testing-library/preact';
import { signal } from '@preact/signals';

// Create a fresh signal for the test module
const mockActiveRoom = signal(null);

vi.mock('../../lib/signals', () => ({
  activeRoomSignal: mockActiveRoom,
}));

afterEach(() => {
  cleanup();
  mockActiveRoom.value = null; // reset between tests
});
```

## Scope

Target components (all in `packages/web/src/`):
- `components/room/RoomSettings.tsx`
- `components/room/RoomAgents.tsx`
- `components/room/RoomContext.tsx`
- `components/room/RoomSessions.tsx`
- `components/ChatComposer.tsx`
- `components/settings/GeneralSettings.tsx`
- `components/settings/FallbackModelsSettings.tsx`
- `components/settings/AddSkillDialog.tsx`
- `components/settings/EditSkillDialog.tsx`

## Tasks

---

### Task 5.1: Test RoomSettings.tsx

**Agent type:** coder

**Description:**
Write tests for `RoomSettings.tsx`, which allows users to configure room-level settings.
This component likely reads from signals (active room, room config) and dispatches RPC
update calls.

**Subtasks (ordered):**
1. Read `packages/web/src/components/room/RoomSettings.tsx` in full. Note all signal
   imports, store imports, and RPC call sites.
2. List all `vi.mock()` stubs needed (typically: signals module, connection-manager or
   rpc-client, toast, router).
3. Create `packages/web/src/components/room/RoomSettings.test.tsx` with:
   - A mock for each external dependency identified in step 2.
   - Fresh signal instances created at module scope and reset in `afterEach`.
   - Tests covering:
     - Initial render: shows current room settings values.
     - User edits a field and submits: the correct RPC call is made with updated data.
     - Validation error: shows error message when submit with invalid data.
     - Cancel/dismiss: no RPC call is made, form state resets.
4. Run `bun run coverage` from `packages/web`. Confirm `RoomSettings.tsx` shows >= 80%
   line coverage.
5. Create feature branch `test/web-complex-components`, commit, and open PR via
   `gh pr create`.

**Acceptance criteria:**
- `packages/web/src/components/room/RoomSettings.test.tsx` exists and all tests pass.
- `RoomSettings.tsx` shows >= 80% line coverage.
- Changes are on a feature branch with a GitHub PR created via `gh pr create`.

**Depends on:** Milestone 1 Task 1.1, Milestone 2 baseline (to understand current state)

---

### Task 5.2: Test RoomAgents.tsx and RoomContext.tsx

**Agent type:** coder

**Description:**
Write tests for `RoomAgents.tsx` (lists and manages agents in a room) and `RoomContext.tsx`
(displays or edits the room context/system prompt). Both components are signal-coupled and
may dispatch RPC calls on user interaction.

**Subtasks (ordered):**
1. Read `packages/web/src/components/room/RoomAgents.tsx` and
   `packages/web/src/components/room/RoomContext.tsx`.
2. For `RoomAgents.tsx`, create `RoomAgents.test.tsx` covering:
   - Renders the list of agents from the signal.
   - Empty state when no agents exist.
   - Agent removal: clicking remove triggers the correct callback or RPC call.
   - Agent addition: if an add-agent action exists, verify the dialog/flow opens.
3. For `RoomContext.tsx`, create `RoomContext.test.tsx` covering:
   - Renders the current context text.
   - Editing and saving context triggers the correct RPC call.
   - If context is empty, shows a placeholder or empty state.
4. Use the signal mocking pattern described in the milestone header.
5. Run `bun run coverage` from `packages/web`. Confirm both source files show >= 75%
   line coverage.
6. Commit to `test/web-complex-components` branch.

**Acceptance criteria:**
- Both test files exist and all tests pass.
- Both source files show >= 75% line coverage.
- Changes are on a feature branch with a GitHub PR created via `gh pr create`.

**Depends on:** Milestone 1 Task 1.1

---

### Task 5.3: Test RoomSessions.tsx and ChatComposer.tsx

**Agent type:** coder

**Description:**
Write tests for `RoomSessions.tsx` (session list within a room) and `ChatComposer.tsx`
(the chat input component). `ChatComposer` is among the more complex components — it likely
manages text input state, handles keyboard shortcuts, and dispatches send events.

**Subtasks (ordered):**
1. Read `packages/web/src/components/room/RoomSessions.tsx`. Note how it retrieves and
   renders sessions.
2. Read `packages/web/src/components/ChatComposer.tsx`. Identify:
   - Signal dependencies (active session, current room, etc.)
   - Event handlers (onSend, keyboard shortcuts)
   - Any file attachment or reference autocomplete features
3. Create `packages/web/src/components/room/RoomSessions.test.tsx` covering:
   - Renders list of sessions from signal data.
   - Empty state when no sessions exist.
   - Clicking a session triggers navigation or selection callback.
4. Create `packages/web/src/components/ChatComposer.test.tsx` covering:
   - Renders a text area or input.
   - Typing in the input updates local state.
   - Pressing Enter (or clicking send) calls the send callback with the message text.
   - Shift+Enter or other modifier keys do NOT submit (if applicable).
   - Textarea is disabled when the session is not in a sendable state.
5. Mock all signal and RPC dependencies. Use `fireEvent` for keyboard interactions.
6. Run `bun run coverage` from `packages/web`. Confirm both files show >= 75% line coverage.
7. Commit to `test/web-complex-components` branch.

**Acceptance criteria:**
- Both test files exist and all tests pass.
- Both source files show >= 75% line coverage.
- Changes are on a feature branch with a GitHub PR created via `gh pr create`.

**Depends on:** Milestone 1 Task 1.1

---

### Task 5.4: Test GeneralSettings.tsx and FallbackModelsSettings.tsx

**Agent type:** coder

**Description:**
Write tests for two settings page components. `GeneralSettings.tsx` likely manages
workspace-level settings (workspace path, theme, etc.). `FallbackModelsSettings.tsx` manages
the model fallback configuration.

**Subtasks (ordered):**
1. Read both source files to understand their props, signals used, and RPC calls.
2. Create `packages/web/src/components/settings/GeneralSettings.test.tsx` covering:
   - Renders current settings values from mocked signal/store data.
   - User changes a setting and saves: the correct RPC call is made.
   - Error state: shows an error when the RPC call fails.
3. Create `packages/web/src/components/settings/FallbackModelsSettings.test.tsx` covering:
   - Renders the list of available models.
   - Toggling a model on/off calls the correct RPC handler.
   - Order/priority changes are reflected in the call payload.
4. Use `vi.mock()` for all external dependencies.
5. Run `bun run coverage` from `packages/web`. Confirm both files show >= 75% line coverage.
6. Commit to `test/web-complex-components` branch.

**Acceptance criteria:**
- Both test files exist and all tests pass.
- Both source files show >= 75% line coverage.
- Changes are on a feature branch with a GitHub PR created via `gh pr create`.

**Depends on:** Milestone 1 Task 1.1

---

### Task 5.5: Test AddSkillDialog.tsx and EditSkillDialog.tsx

**Agent type:** coder

**Description:**
Write tests for the skill management dialogs. These dialogs collect user input (skill name,
URL, description) and dispatch create/update RPC calls. They likely include form validation.

**Subtasks (ordered):**
1. Read `packages/web/src/components/settings/AddSkillDialog.tsx` and
   `packages/web/src/components/settings/EditSkillDialog.tsx`.
2. Create `packages/web/src/components/settings/AddSkillDialog.test.tsx` covering:
   - Dialog is hidden when `isOpen` is false.
   - Dialog renders form fields when `isOpen` is true.
   - Submitting with required fields filled calls `onAdd` with the correct data.
   - Submitting with missing required fields shows validation errors.
   - Cancelling calls `onCancel` without triggering the add callback.
3. Create `packages/web/src/components/settings/EditSkillDialog.test.tsx` covering:
   - Pre-populates form fields with the provided `skill` prop values.
   - Submitting with valid edits calls `onSave` with updated data.
   - Delete/remove action (if present) calls the delete callback.
   - Cancelling leaves the skill unchanged.
4. Use `fireEvent` for form interactions and `waitFor` if there are async submit handlers.
5. Run `bun run coverage` from `packages/web`. Confirm both files show >= 80% line coverage.
6. Commit to `test/web-complex-components` branch and open/update the PR.

**Acceptance criteria:**
- Both test files exist and all tests pass.
- Both source files show >= 80% line coverage.
- Changes are on a feature branch with a GitHub PR created via `gh pr create`.

**Depends on:** Milestone 1 Task 1.1
