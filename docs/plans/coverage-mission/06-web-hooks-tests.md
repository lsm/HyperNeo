# Milestone 6: Web Hooks Tests

## Milestone Goal

Write tests for two custom Preact hooks that currently lack test coverage:
`useChatComposerController.ts` and `useSkills.ts`. Custom hooks in Preact are tested with
`renderHook` from `@testing-library/preact` in the same way as React hooks.

## Testing Pattern: renderHook

```tsx
import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/preact';
import { useMyHook } from './useMyHook';

afterEach(() => cleanup());

describe('useMyHook', () => {
  it('returns initial state', () => {
    const { result } = renderHook(() => useMyHook());
    expect(result.current.value).toBe(initialValue);
  });

  it('updates state when action called', () => {
    const { result } = renderHook(() => useMyHook());
    act(() => {
      result.current.doAction('input');
    });
    expect(result.current.value).toBe(expectedValue);
  });
});
```

If the hook reads from signals, stub the signal module with `vi.mock()` before the
`renderHook` call (at module scope). If it fires RPC calls, mock the RPC client.

## Scope

Target files (both in `packages/web/src/hooks/`):
- `useChatComposerController.ts`
- `useSkills.ts`

## Tasks

---

### Task 6.1: Test useChatComposerController.ts

**Agent type:** coder

**Description:**
Write tests for `useChatComposerController.ts`, which manages the state and behavior of the
chat composer (message text, attachment state, send action, keyboard interaction logic).

**Subtasks (ordered):**
1. Read `packages/web/src/hooks/useChatComposerController.ts` in full. Document:
   - What signals or stores it reads.
   - What state it manages internally (text value, loading, etc.).
   - What functions it returns to callers.
   - What external calls it makes on submit (RPC, store dispatch).
2. Identify all external imports that need to be mocked.
3. Create `packages/web/src/hooks/useChatComposerController.test.ts`:
   - Use `vi.mock()` for all signal and RPC dependencies.
   - Test initial return values from `renderHook`.
   - Test that setting the text value through the returned setter updates state.
   - Test the submit path: calling the returned send function dispatches the correct
     action/RPC with the message text.
   - Test that the hook resets text state after a successful send.
   - Test that the hook is disabled (or returns a no-op send) when the session is not ready.
   - If the hook manages `isLoading` state, test the loading → idle transition.
4. Run `bun run coverage` from `packages/web`. Confirm `useChatComposerController.ts`
   shows >= 80% line coverage.
5. Create feature branch `test/web-hooks`, commit, and open a PR via `gh pr create`.

**Acceptance criteria:**
- `packages/web/src/hooks/useChatComposerController.test.ts` exists and all tests pass.
- `useChatComposerController.ts` shows >= 80% line coverage.
- Changes are on a feature branch with a GitHub PR created via `gh pr create`.

**Depends on:** Milestone 1 Task 1.1

---

### Task 6.2: Test useSkills.ts

**Agent type:** coder

**Description:**
Write tests for `useSkills.ts`, which provides skill data and management actions to
components. It likely reads from a signal or store, and exposes functions for adding,
updating, enabling/disabling, and removing skills.

**Subtasks (ordered):**
1. Read `packages/web/src/hooks/useSkills.ts` in full. Document:
   - What signal, store, or context it reads.
   - What it returns (skill list, loading state, action functions).
   - How it triggers RPC calls on skill mutations.
2. Identify and plan all `vi.mock()` stubs needed.
3. Create `packages/web/src/hooks/useSkills.test.ts`:
   - Test that the hook returns the skills list from the mocked signal/store.
   - Test that the hook returns an empty array (or the loading state) when data is not
     yet available.
   - Test each returned action function:
     - `addSkill` / `createSkill`: dispatches the correct RPC with skill params.
     - `updateSkill`: dispatches update RPC with correct id and fields.
     - `setSkillEnabled` / `toggleEnabled`: dispatches enable/disable RPC.
     - `deleteSkill`: dispatches delete RPC.
   - Test error handling: when the RPC rejects, the hook does not throw unhandled.
4. Run `bun run coverage` from `packages/web`. Confirm `useSkills.ts` shows >= 80%
   line coverage.
5. Commit to `test/web-hooks` branch and open/update the PR.

**Acceptance criteria:**
- `packages/web/src/hooks/useSkills.test.ts` exists and all tests pass.
- `useSkills.ts` shows >= 80% line coverage.
- Changes are on a feature branch with a GitHub PR created via `gh pr create`.

**Depends on:** Milestone 1 Task 1.1
