# Test IDs Documentation

This document lists all the `data-testid` attributes used in the application for E2E testing.

## Sidebar Component (`/packages/web/src/islands/Sidebar.tsx`)

- `data-testid="session-card"` - Each session card in the sidebar
- `data-session-id="[sessionId]"` - Session ID attribute for each card
- `data-testid="new-session-btn"` - New Session button
- `data-testid="sidebar"` - Main sidebar container
- `data-testid="settings-btn"` - Settings button in footer

## Chat Container (`/packages/web/src/islands/ChatContainer.tsx`)

- `data-testid="confirm-delete-session"` - Confirm delete button in modal
- `data-testid="message-input"` - Message input textarea
- `data-testid="send-btn"` - Send message button
- `data-testid="session-info-btn"` - Session info panel trigger (toolbar with Tools, Export chat, Rename, Reset, Archive session, Delete chat)
- `data-testid="error-banner"` - Error message banner
- `data-message-role="[user|assistant]"` - Role attribute for messages

## Main Content (`/packages/web/src/islands/MainContent.tsx`)

- `data-testid="welcome-screen"` - Welcome/home screen container
- `data-testid="chat-container"` - Chat container wrapper

## Status Indicator

- `data-testid="status-indicator"` - Status indicator container
- `data-testid="connection-status"` - Connection status text
- `data-testid="processing-status"` - Processing status text

## Messages

- `data-testid="message"` - Individual message container
- `data-testid="user-message"` - User message
- `data-testid="assistant-message"` - Assistant message
- `data-testid="streaming-message"` - Streaming message placeholder
- `data-testid="tool-call"` - Tool call display

## Modals

- `data-testid="modal-backdrop"` - Modal backdrop
- `data-testid="modal-content"` - Modal content container
- `data-testid="modal-close"` - Modal close button

## Forms

- `data-testid="auth-form"` - Authentication form
- `data-testid="api-key-input"` - API key input field
- `data-testid="save-auth-btn"` - Save authentication button

## Loading States

- `data-testid="skeleton-loader"` - Skeleton loader component
- `data-testid="spinner"` - Loading spinner

## Navigation

- `data-testid="hamburger-menu"` - Mobile menu button
- `data-testid="close-sidebar"` - Close sidebar button (mobile)

## State Attributes

These attributes help with waiting for specific states:

- `data-messagehub-connected="true|false"` - MessageHub connection state
- `data-sessions-loaded="true|false"` - Sessions list loaded state
- `data-processing="true|false"` - Message processing state
- `data-error-state="true|false"` - Error state present

## Usage in Tests

```typescript
// Wait for element by test ID
const sessionCard = await page.locator('[data-testid="session-card"]').first();

// Wait for specific session
const session = await page.locator(`[data-session-id="${sessionId}"]`);

// Check state attributes
await page.waitForSelector('[data-messagehub-connected="true"]');

// Multiple selectors
const deleteBtn = page.getByTestId('confirm-delete-session');
```

## Adding New Test IDs

When adding new test IDs:

1. Use kebab-case: `data-testid="my-component"`
2. Be specific: `data-testid="sidebar-new-session-btn"` not just `data-testid="button"`
3. Add state attributes for dynamic states: `data-loading="true"`
4. Document in this file
5. Use semantic names that describe the component's purpose

## Test ID Naming Convention

- Buttons: `*-btn`
- Inputs: `*-input`
- Containers: `*-container`
- Cards: `*-card`
- Modals: `*-modal`
- Forms: `*-form`
- Status/State: `*-status`
- Navigation: `*-nav`
