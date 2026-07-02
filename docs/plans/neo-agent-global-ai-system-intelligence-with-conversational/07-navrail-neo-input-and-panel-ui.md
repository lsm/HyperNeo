# Milestone 7: NavRail Neo Input and Panel UI

## Goal

Build the frontend conversational interface for Neo: a persistent input in the NavRail and a slide-out panel with chat history and activity feed.

## Scope

- NavRail icon button (the rail is 64px/`w-16` -- too narrow for a text input; text entry happens inside the panel)
- Slide-out Neo panel with Chat and Activity Feed tabs, including the primary text input at the bottom of the panel
- Neo store for frontend state management
- Message display with structured data support
- Confirmation card UI for action approval

## Tasks

### Task 7.1: Neo Frontend Store

**Description**: Create the signal-based frontend store for Neo's state.

**Subtasks**:
1. Create `packages/web/src/lib/neo-store.ts`:
   - `NeoStore` class following the `LobbyStore` / `SkillsStore` pattern
   - Signals: `messages`, `activity`, `loading`, `panelOpen`, `activeTab` ('chat' | 'activity')
   - `pendingConfirmation` signal for action confirmation flow
2. Methods:
   - `sendMessage(text)`: calls `neo.send` RPC, adds user message to signal
   - `loadHistory()`: calls `neo.history` RPC on init
   - `loadActivity()`: subscribes to `neo.activity` LiveQuery
   - `clearSession()`: calls `neo.clearSession` RPC
   - `confirmAction(actionId)` / `cancelAction(actionId)`: for confirmation flow
   - `openPanel()` / `closePanel()` / `togglePanel()`: panel visibility
3. Subscribe to `neo.messages` LiveQuery for real-time updates
4. Persist `panelOpen` state in localStorage
5. Create singleton `neoStore` export
6. Add unit tests for store methods

**Acceptance Criteria**:
- Store manages Neo messages and activity reactively
- LiveQuery subscriptions provide real-time updates
- Panel state persists across page reloads
- Unit tests pass

**Dependencies**: Task 4.1, Task 4.2

**Agent type**: coder

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

### Task 7.2: NavRail Neo Icon Button

**Description**: Add a persistent icon button to the NavRail that toggles the Neo panel. The NavRail is 64px wide (`w-16`), which cannot fit a text input -- so we use an icon button instead. All text input happens inside the panel.

**Subtasks**:
1. Create `packages/web/src/components/neo/NeoNavButton.tsx`:
   - Icon button (sparkles icon or similar, distinct from other nav items) fitting within the 64px rail
   - On click: toggles `neoStore.togglePanel()` and auto-focuses the panel's text input when opening
   - Active/highlighted state when panel is open
   - Tooltip: "Neo (⌘J)" on hover
   - Keyboard shortcut: `Cmd+J` (Mac) / `Ctrl+J` (Win) to toggle the panel. Note: Firefox uses Cmd+J for Downloads -- `preventDefault()` overrides this within the app tab, which is acceptable since HyperNeo is a dedicated web app. Consider making the shortcut user-configurable in a future iteration.
2. Update `packages/web/src/islands/NavRail.tsx`:
   - Import and render `NeoNavButton` between nav items and settings button (same position as other nav icons)
3. Register global keyboard shortcut handler at the app level (in `App.tsx` or a dedicated hook):
   - `Cmd+J` / `Ctrl+J`: toggle Neo panel
   - Verify no conflicts with existing shortcuts in the codebase (currently none registered)
   - Use `preventDefault()` to override browser defaults within the app
4. Style with Tailwind: dark theme, consistent with other NavRail icon buttons
5. Add component unit test (renders, handles click, triggers store methods)

**Acceptance Criteria**:
- Icon button is visible at all times in the NavRail, fitting the 64px width
- Clicking opens the Neo panel and focuses the panel's text input
- `Cmd+J` / `Ctrl+J` toggles the panel from anywhere
- Visually distinct from navigation items but consistent with NavRail style
- Unit test passes

**Dependencies**: Task 7.1

**Agent type**: coder

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

### Task 7.3: Neo Slide-Out Panel

**Description**: Create the main Neo panel that slides out from the NavRail.

**Subtasks**:
1. Create `packages/web/src/components/neo/NeoPanel.tsx`:
   - Slides in from the left, overlapping or pushing content
   - Header with "Neo" title, tab switcher (Chat / Activity), close button
   - Controlled by `neoStore.panelOpen` signal
   - Smooth CSS transition for slide-in/out animation
2. Create `packages/web/src/components/neo/NeoChatView.tsx`:
   - Message list: renders user messages and Neo responses
   - Auto-scrolls to newest message
   - Supports text responses and structured data (JSON rendered as formatted cards/tables)
   - Input bar at bottom (this is the primary text input for Neo -- the NavRail only has an icon button)
3. Create `packages/web/src/components/neo/NeoActivityView.tsx`:
   - Scrollable list of Neo's past actions from `neoStore.activity`
   - Each entry: timestamp, tool name, target description, status (success/error), outcome summary
   - Click to expand for full details
4. Create `packages/web/src/components/neo/NeoConfirmationCard.tsx`:
   - Inline card in chat when Neo needs confirmation
   - Shows: action description, target, risk level
   - Confirm / Cancel buttons call `neo.confirmAction` / `neo.cancelAction` RPC **directly** (primary path, bypasses LLM for reliability)
   - User can also type "yes" / "no" / "confirm" in the panel's input bar (secondary path, LLM-mediated)
   - Confirmation cards remain interactive in chat history until the pending action's TTL expires (5 minutes)
5. Create error state UI in `NeoChatView.tsx`:
   - **Provider unavailable**: "Neo is temporarily unavailable. Please try again." (on 429/5xx errors)
   - **No credentials**: "API key not configured. Please set up your provider in Settings." with link to Settings
   - **Model unavailable**: "The selected model is not available. Please update Neo's model in Settings."
   - Error states are rendered as styled message cards in the chat, not alerts/modals
6. Wire panel into `packages/web/src/islands/MainContent.tsx` or appropriate layout component
7. Handle click-outside-to-dismiss
8. Add component unit tests

**Acceptance Criteria**:
- Panel slides in/out smoothly
- Chat view displays messages with auto-scroll
- Activity view shows action history
- Confirmation cards render with Confirm/Cancel buttons that call RPC directly
- Provider error states display user-friendly messages with appropriate guidance
- Panel dismisses on close button or click outside
- Unit tests pass

**Dependencies**: Task 7.1, Task 7.2

**Agent type**: coder

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.
