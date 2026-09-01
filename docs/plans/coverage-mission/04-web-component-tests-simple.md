# Milestone 4: Web Component Tests (Simple)

## Milestone Goal

Write tests for simpler web components that have limited or no Preact Signal dependencies.
These components can be tested with `render()` from `@testing-library/preact` plus basic
assertions. The goal is to add meaningful rendering and behavior tests, not just
smoke-tests.

## Testing Pattern

Use `@testing-library/preact` (v3.2.4 — already installed) with the happy-dom environment.

Standard test structure:
```tsx
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen } from '@testing-library/preact';

afterEach(() => cleanup());

describe('ComponentName', () => {
  it('renders with default props', () => {
    render(<ComponentName />);
    expect(screen.getByText('...')).toBeTruthy();
  });
});
```

For components that import from signals or stores, use `vi.mock()` at the top level to stub
out the signal module, then configure mock return values per test.

Place test files as `<component-dir>/<ComponentName>.test.tsx` co-located with the source.

## Scope

Target components (all in `packages/web/src/`):
- `components/ui/EmptyState.tsx`
- `components/ui/MobileMenuButton.tsx`
- `components/sdk/RunningBorder.tsx`
- `components/sdk/SDKRateLimitEvent.tsx`
- `components/sdk/SDKResumeChoiceMessage.tsx`
- `components/sdk/MessageInfoButton.tsx`
- `components/DaemonStatusIndicator.tsx`
- `components/ui/RejectModal.tsx`
- `components/space/SpacePageHeader.tsx`
- `components/space/PendingTaskCompletionBanner.tsx`

## Tasks

---

### Task 4.1: Test EmptyState and MobileMenuButton

**Agent type:** coder

**Description:**
Write tests for two simple, low-dependency UI components that render static or props-driven
content.

**Subtasks (ordered):**
1. Read `packages/web/src/components/ui/EmptyState.tsx` to understand its props interface and
   render output.
2. Create `packages/web/src/components/ui/EmptyState.test.tsx`:
   - Renders the icon or placeholder element.
   - Renders the title text when provided.
   - Renders the description text when provided.
   - Renders children or a CTA slot when provided.
3. Read `packages/web/src/components/ui/MobileMenuButton.tsx` to understand its props and
   behavior (click handlers, open/closed state).
4. Create `packages/web/src/components/ui/MobileMenuButton.test.tsx`:
   - Renders a button element.
   - Calls `onClick` prop when clicked (use `fireEvent.click`).
   - Shows the correct visual state when `isOpen` prop changes.
5. Run `bun run coverage` from `packages/web` to confirm both source files are covered.
6. Create a feature branch `test/web-simple-components`, commit, and open a PR via
   `gh pr create`.

**Acceptance criteria:**
- Both test files exist and all tests pass.
- Both source files show >= 90% line coverage.
- Changes are on a feature branch with a GitHub PR created via `gh pr create`.

**Depends on:** Milestone 1 Task 1.1

---

### Task 4.2: Test SDK event components (RunningBorder, SDKRateLimitEvent, SDKResumeChoiceMessage, MessageInfoButton)

**Agent type:** coder

**Description:**
Write tests for four SDK-related display components. These components typically receive typed
SDK event payloads as props and render their content as formatted UI.

**Subtasks (ordered):**
1. Read each of the four source files to understand their props interfaces:
   - `packages/web/src/components/sdk/RunningBorder.tsx`
   - `packages/web/src/components/sdk/SDKRateLimitEvent.tsx`
   - `packages/web/src/components/sdk/SDKResumeChoiceMessage.tsx`
   - `packages/web/src/components/sdk/MessageInfoButton.tsx`
2. For `RunningBorder.tsx`: create a test verifying the animated border renders and wraps
   children correctly.
3. For `SDKRateLimitEvent.tsx`: create a test providing a mock rate-limit payload and
   verifying the rendered output includes rate-limit information (e.g., reset time text).
4. For `SDKResumeChoiceMessage.tsx`: create a test verifying choice buttons render and that
   the appropriate callback is invoked when a choice is clicked.
5. For `MessageInfoButton.tsx`: create a test verifying a button renders and `onClick` fires.
6. Place each test as `<ComponentName>.test.tsx` in the same directory as the source.
7. Run `bun run coverage` from `packages/web` and confirm all four files are covered.
8. Commit to `test/web-simple-components` branch.

**Acceptance criteria:**
- Four test files exist, all tests pass.
- All four source files show >= 85% line coverage.
- Changes are on a feature branch with a GitHub PR created via `gh pr create`.

**Depends on:** Milestone 1 Task 1.1

---

### Task 4.3: Test DaemonStatusIndicator and RejectModal

**Agent type:** coder

**Description:**
Write tests for `DaemonStatusIndicator.tsx` (shows connection/health state) and `RejectModal.tsx`
(a confirmation dialog). `DaemonStatusIndicator` may read from a signal or prop — use
`vi.mock()` if it imports from a signal module. `RejectModal` likely has props for
`onConfirm` and `onCancel` callbacks.

**Subtasks (ordered):**
1. Read `packages/web/src/components/DaemonStatusIndicator.tsx`. If it imports signals,
   identify the signal module path.
2. Create `packages/web/src/components/DaemonStatusIndicator.test.tsx`:
   - If signal-dependent: use `vi.mock()` to stub the signal module.
   - Render with each status value (connected, disconnected, reconnecting) and assert the
     correct status indicator/text is shown.
3. Read `packages/web/src/components/ui/RejectModal.tsx` to understand its props.
4. Create `packages/web/src/components/ui/RejectModal.test.tsx`:
   - Renders the modal with the provided `message` or content.
   - Calls `onConfirm` when the confirm button is clicked.
   - Calls `onCancel` when the cancel/dismiss action is triggered.
   - Does not render (or renders hidden) when `isOpen` is false (if that prop exists).
5. Run `bun run coverage` from `packages/web` to confirm both files are covered.
6. Commit to `test/web-simple-components` branch.

**Acceptance criteria:**
- Both test files exist, all tests pass.
- Both source files show >= 85% line coverage.
- Changes are on a feature branch with a GitHub PR created via `gh pr create`.

**Depends on:** Milestone 1 Task 1.1

---

### Task 4.4: Test SpacePageHeader and PendingTaskCompletionBanner

**Agent type:** coder

**Description:**
Write tests for two space-related display components. `SpacePageHeader` likely renders a
space name and navigation elements. `PendingTaskCompletionBanner` renders a banner when a
task is pending human review. Both may depend on props or signals for their content.

**Subtasks (ordered):**
1. Read `packages/web/src/components/space/SpacePageHeader.tsx` and
   `packages/web/src/components/space/PendingTaskCompletionBanner.tsx`.
2. For each component, identify all external imports (signals, stores, router) and plan
   `vi.mock()` stubs accordingly.
3. Create `packages/web/src/components/space/SpacePageHeader.test.tsx`:
   - Renders the space name/title passed as a prop.
   - Renders navigation elements (back button, settings link) if present.
   - Mocks signal or store imports to provide controlled test data.
4. Create `packages/web/src/components/space/PendingTaskCompletionBanner.test.tsx`:
   - Does not render when there is no pending task.
   - Renders with the task title/description when a pending task is present.
   - Calls the approval or rejection callback when the corresponding button is clicked.
5. Run `bun run coverage` from `packages/web` to confirm both files are covered.
6. Commit to `test/web-simple-components` branch and open the PR.

**Acceptance criteria:**
- Both test files exist, all tests pass.
- Both source files show >= 80% line coverage.
- Changes are on a feature branch with a GitHub PR created via `gh pr create`.

**Depends on:** Milestone 1 Task 1.1
