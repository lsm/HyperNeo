/**
 * Space Task Messaging & @mention Autocomplete E2E Tests (M7.5)
 *
 * Verifies that users can interact with the task thread composer in SpaceTaskPane:
 *
 *   Scenario 1 — Composer renders for tasks with an agent session:
 *     The inline composer textarea renders when the task has a taskAgentSessionId
 *     and is non-terminal (in_progress).
 *
 *   Scenario 2 — Message sending via the inline composer:
 *     Typing a message and pressing Enter submits the draft.
 *     The draft clears on a successful send; an error message appears on failure.
 *     Both outcomes are acceptable — the test verifies the submit path was reached.
 *
 *   Scenario 3 — @mention autocomplete is scoped to workflow agents:
 *     For non-workflow tasks, typing "@" does NOT show the autocomplete dropdown.
 *     The autocomplete only appears for workflow tasks with defined workflow agents.
 *     (Behavior after PR #1440: scope @mention autocomplete to workflow agents only.)
 *
 * Setup:
 *   - A unique workspace directory is created in beforeEach.
 *   - Space + task are created via RPC.
 *   - A human session is created via RPC and linked to the task as
 *     taskAgentSessionId, task is set to "in_progress" status so the inline
 *     composer renders (showInlineComposer = !!agentSessionId && !isTerminal).
 *
 * Technical note on input:
 *   Preact controlled inputs use `onInput` which is mapped to the native browser
 *   `input` event.  Playwright's `fill()` sets the DOM value via JS and dispatches
 *   a synthetic `input` event, but Preact may re-render and reset the value before
 *   the state update is batched in.  Using `pressSequentially()` fires genuine
 *   keyboard events (keydown/keypress/input/keyup) which Preact reliably intercepts,
 *   making it the recommended approach for Preact controlled textarea inputs.
 *
 * Cleanup:
 *   - Space is deleted via RPC in afterEach.
 *   - Session is deleted via RPC in afterEach.
 *   - Unique workspace directory is removed in afterEach.
 *
 * E2E Rules:
 *   - All test actions go through the UI (clicks, typing, navigation, keyboard).
 *   - All assertions check visible DOM state.
 *   - RPC is only used in beforeEach / afterEach for infrastructure setup / teardown.
 *
 * Timeout conventions:
 *   - 10000ms: server round-trips (store hydration, RPC calls)
 *   - 5000ms:  local UI changes (composer visibility, dropdown toggle)
 *   - 3000ms:  immediate UI reactions (autocomplete on keystroke)
 */

import { existsSync, rmSync } from 'node:fs';
import { test, expect } from '../../fixtures';
import { waitForWebSocketConnected, getWorkspaceRoot } from '../helpers/wait-helpers';
import {
  createSpaceViaRpc,
  createSpaceTaskViaRpc,
  createUniqueSpaceDir,
  deleteSpaceViaRpc,
} from '../helpers/space-helpers';

const DESKTOP_VIEWPORT = { width: 1440, height: 900 };

// ─── Infrastructure helpers (RPC — beforeEach / afterEach only) ────────────────

interface TaskMessagingTestContext {
  spaceId: string;
  taskId: string;
  sessionId: string;
  wsPath: string;
}

/**
 * Create a space with a task in in_progress status that has a human session
 * linked as taskAgentSessionId.
 *
 * Setting taskAgentSessionId on a non-terminal task causes SpaceTaskPane to
 * render the inline composer (showInlineComposer = !!agentSessionId && !isTerminal).
 *
 * The session is linked and the task is moved to in_progress in a single
 * spaceTask.update call so there is only one space.task.updated event, reducing
 * the window for the space runtime to see an inconsistent state.
 */
async function createSpaceWithMessagingTask(
  page: Parameters<typeof waitForWebSocketConnected>[0]
): Promise<TaskMessagingTestContext> {
  await waitForWebSocketConnected(page);
  const workspaceRoot = await getWorkspaceRoot(page);
  const wsPath = createUniqueSpaceDir(workspaceRoot, 'task-msg');

  const spaceName = `E2E Task Messaging ${Date.now()}`;
  const spaceId = await createSpaceViaRpc(page, wsPath, spaceName);
  const taskId = await createSpaceTaskViaRpc(page, spaceId, 'Messaging test task');

  // Create a human session and link it to the task in a single update.
  // Using one update keeps the task in a consistent state (session set AND
  // in_progress together) so the frontend's ensureTaskAgentSession effect sees
  // the task with taskAgentSessionId already set (showSpawnLoading = false).
  const sessionId = await page.evaluate(
    async ({ wsPath, spaceId, taskId }) => {
      const hub = window.__messageHub || window.appState?.messageHub;
      if (!hub?.request) throw new Error('MessageHub not available');

      // Create a lightweight human session (no AI model invoked at creation time).
      // session.create returns { sessionId, session } — not { id }.
      const { sessionId: newSessionId } = (await hub.request('session.create', {
        workspacePath: wsPath,
        createdBy: 'human',
      })) as { sessionId: string };

      // Link session + transition to in_progress in one RPC so the frontend sees
      // a coherent task state (taskAgentSessionId set + in_progress).
      await hub.request('spaceTask.update', {
        spaceId,
        taskId,
        taskAgentSessionId: newSessionId,
        status: 'in_progress',
      });

      return newSessionId;
    },
    { wsPath, spaceId, taskId }
  );

  return { spaceId, taskId, sessionId, wsPath };
}

/**
 * Delete a session via RPC. Best-effort for afterEach cleanup.
 */
async function deleteSessionViaRpc(
  page: Parameters<typeof waitForWebSocketConnected>[0],
  sessionId: string
): Promise<void> {
  if (!sessionId) return;
  try {
    await page.evaluate(async (id) => {
      const hub = window.__messageHub || window.appState?.messageHub;
      if (!hub?.request) return;
      await hub.request('session.delete', { sessionId: id });
    }, sessionId);
  } catch {
    // Best-effort cleanup
  }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

test.describe('Space Task Messaging & @mention Autocomplete', () => {
  // Serial mode: tests share describe-scoped let variables and each beforeEach
  // creates fresh state. Serial execution ensures variables aren't overwritten
  // mid-test by another test's beforeEach running on the same worker.
  test.describe.configure({ mode: 'serial' });
  test.use({ viewport: DESKTOP_VIEWPORT });

  let spaceId = '';
  let taskId = '';
  let sessionId = '';
  let wsPath = '';

  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    const ctx = await createSpaceWithMessagingTask(page);
    spaceId = ctx.spaceId;
    taskId = ctx.taskId;
    sessionId = ctx.sessionId;
    wsPath = ctx.wsPath;
  });

  test.afterEach(async ({ page }) => {
    if (sessionId) {
      await deleteSessionViaRpc(page, sessionId);
      sessionId = '';
    }
    if (spaceId) {
      await deleteSpaceViaRpc(page, spaceId);
      spaceId = '';
    }
    taskId = '';
    if (wsPath && existsSync(wsPath)) {
      try {
        rmSync(wsPath, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup
      }
      wsPath = '';
    }
  });

  // ─── Scenario 1: Inline composer renders when task has an agent session ────

  test('inline composer textarea renders when task has a taskAgentSessionId', async ({ page }) => {
    await page.goto(`/space/${spaceId}/task/${taskId}`);
    await page.waitForURL(`/space/${spaceId}/task/${taskId}`, { timeout: 10000 });

    // The task thread panel (container for SpaceTaskUnifiedThread) must be present.
    await expect(page.getByTestId('task-thread-panel')).toBeAttached({ timeout: 10000 });

    // The inline composer renders because taskAgentSessionId is set and the
    // task is non-terminal (in_progress).
    const composerTextarea = page.getByPlaceholder('Message task agent...');
    await expect(composerTextarea).toBeVisible({ timeout: 10000 });
  });

  // ─── Scenario 2: Message sending via the composer ────────────────────���────

  test('user can type a message and submit it via Enter key', async ({ page }) => {
    await page.goto(`/space/${spaceId}/task/${taskId}`);
    await page.waitForURL(`/space/${spaceId}/task/${taskId}`, { timeout: 10000 });

    const composerTextarea = page.getByPlaceholder('Message task agent...');
    await expect(composerTextarea).toBeVisible({ timeout: 10000 });

    // Use pressSequentially to type the message character by character.
    // This fires genuine keyboard events (keydown/keypress/input/keyup) that
    // Preact's onInput handler picks up, updating the threadDraft state.
    // Note: fill() may not reliably trigger Preact controlled input state updates.
    const testMessage = 'Hello from E2E test';
    await composerTextarea.click();
    await composerTextarea.pressSequentially(testMessage, { delay: 10 });

    // Verify the draft state was updated (Preact controlled value reflects typing).
    await expect(composerTextarea).toHaveValue(testMessage, { timeout: 3000 });

    // Press Enter to submit the form (works regardless of button disabled state).
    await composerTextarea.press('Enter');

    // After submit the draft should clear (success path) or show an error
    // (graceful failure path — e.g. no live task agent session).
    // We accept both outcomes: both mean the submit path was executed.
    // If neither condition is met within the timeout, Promise.race rejects
    // and the test fails — this is intentional to catch regressions where
    // the submit handler silently does nothing.
    await Promise.race([
      // Success: textarea emptied
      expect(composerTextarea).toHaveValue('', { timeout: 10000 }),
      // Graceful failure: error message shown
      expect(page.locator('p.text-red-300')).toBeVisible({ timeout: 10000 }),
    ]);
  });

  // ─── Scenario 3: Shift+Enter inserts a newline (does NOT submit) ─────────

  test('Shift+Enter inserts a newline rather than submitting', async ({ page }) => {
    await page.goto(`/space/${spaceId}/task/${taskId}`);
    await page.waitForURL(`/space/${spaceId}/task/${taskId}`, { timeout: 10000 });

    const composerTextarea = page.getByPlaceholder('Message task agent...');
    await expect(composerTextarea).toBeVisible({ timeout: 10000 });

    await composerTextarea.click();
    await composerTextarea.pressSequentially('Line one', { delay: 10 });

    // Shift+Enter should NOT submit — just add a newline.
    await composerTextarea.press('Shift+Enter');
    await composerTextarea.pressSequentially('Line two', { delay: 10 });

    // Textarea should still have both lines (not cleared by submit).
    const value = await composerTextarea.inputValue();
    expect(value).toContain('Line one');
    expect(value).toContain('Line two');
  });

  // ─── Scenario 4: @mention autocomplete is scoped to workflow agents ──
  // After PR #1440, @mention autocomplete only shows agents that belong to
  // the task's workflow. Non-workflow tasks have no workflow agents, so
  // the autocomplete dropdown does not appear.

  test('@mention: autocomplete does NOT appear for non-workflow tasks', async ({ page }) => {
    await page.goto(`/space/${spaceId}/task/${taskId}`);
    await page.waitForURL(`/space/${spaceId}/task/${taskId}`, { timeout: 10000 });

    const composerTextarea = page.getByPlaceholder('Message task agent...');
    await expect(composerTextarea).toBeVisible({ timeout: 10000 });

    // Type "@" to attempt to trigger mention autocomplete.
    await composerTextarea.click();
    await composerTextarea.pressSequentially('@', { delay: 10 });

    // For non-workflow tasks, no agents are available so the dropdown
    // should not appear.
    await expect(page.getByTestId('mention-autocomplete')).not.toBeVisible({ timeout: 3000 });

    // The "@" character should still be in the textarea.
    const value = await composerTextarea.inputValue();
    expect(value).toBe('@');
  });
});
