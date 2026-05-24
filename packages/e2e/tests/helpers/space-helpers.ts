/**
 * Shared RPC helpers for space setup and teardown in E2E tests.
 *
 * These helpers are for test infrastructure only (beforeEach/afterEach).
 * All test actions and assertions must go through the browser UI.
 */

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';

/**
 * Create a space via RPC. For use in beforeEach setup only.
 * Returns the new space's id.
 */
export async function createSpaceViaRpc(
  page: Page,
  workspacePath: string,
  name: string
): Promise<string> {
  const id = await page.evaluate(
    async ({ workspacePath, name }) => {
      const hub = window.__messageHub || window.appState?.messageHub;
      if (!hub?.request) throw new Error('MessageHub not available');
      // space.create returns the Space object directly (not wrapped in { space: ... })
      const space = (await hub.request('space.create', { workspacePath, name })) as {
        id: string;
      };
      return space.id;
    },
    { workspacePath, name }
  );
  if (!id) throw new Error('space.create returned no id');
  return id;
}

/**
 * Delete a space via RPC. Best-effort — silently ignores errors so it can be
 * used safely in afterEach without masking test failures.
 */
export async function deleteSpaceViaRpc(page: Page, spaceId: string): Promise<void> {
  if (!spaceId) return;
  try {
    await page.evaluate(async (id) => {
      const hub = window.__messageHub || window.appState?.messageHub;
      if (!hub?.request) return;
      await hub.request('space.delete', { id });
    }, spaceId);
  } catch {
    // Best-effort cleanup
  }
}

/**
 * Create a space task via RPC. For use in beforeEach setup only.
 * Returns the new task's id.
 */
export async function createSpaceTaskViaRpc(
  page: Page,
  spaceId: string,
  title: string
): Promise<string> {
  const id = await page.evaluate(
    async ({ spaceId, title }) => {
      const hub = window.__messageHub || window.appState?.messageHub;
      if (!hub?.request) throw new Error('MessageHub not available');
      const task = (await hub.request('spaceTask.create', {
        spaceId,
        title,
        description: '',
      })) as { id: string };
      return task.id;
    },
    { spaceId, title }
  );
  if (!id) throw new Error('spaceTask.create returned no id');
  return id;
}

/**
 * Update a space task's status (and optionally result) via RPC. For use in beforeEach setup only.
 */
export async function updateSpaceTaskStatusViaRpc(
  page: Page,
  spaceId: string,
  taskId: string,
  status: string,
  result?: string
): Promise<void> {
  await page.evaluate(
    async ({ spaceId, taskId, status, result }) => {
      const hub = window.__messageHub || window.appState?.messageHub;
      if (!hub?.request) throw new Error('MessageHub not available');
      await hub.request('spaceTask.update', { spaceId, taskId, status, result });
    },
    { spaceId, taskId, status, result }
  );
}

/**
 * Delete all seeded workflows for a space via RPC.
 *
 * When a space is created the daemon seeds built-in workflows. This causes
 * `showCanvas` (SpaceIsland) to become `true`, hiding SpaceOverview behind the
 * WorkflowCanvas on desktop viewports via the `md:hidden` CSS class. Tests that
 * need the SpaceOverview to be visible (Create Task button, Active/Review/Done
 * tabs, etc.) must call this helper in beforeEach after space creation.
 *
 * Best-effort — silently ignores errors so it can be used safely in beforeEach
 * without masking test failures.
 */
export async function deleteSpaceWorkflowsViaRpc(page: Page, spaceId: string): Promise<void> {
  if (!spaceId) return;
  try {
    await page.evaluate(async (sid) => {
      const hub = window.__messageHub || window.appState?.messageHub;
      if (!hub?.request) return;
      const result = (await hub.request('spaceWorkflow.list', { spaceId: sid })) as {
        workflows: Array<{ id: string }>;
      };
      for (const wf of result.workflows) {
        await hub.request('spaceWorkflow.delete', { id: wf.id, spaceId: sid });
      }
    }, spaceId);
  } catch {
    // Best-effort cleanup
  }
}

/**
 * Create a unique workspace subdirectory for a space test.
 *
 * Multiple E2E tests run in parallel and all share the same workspace root.
 * Since the `spaces` table has a UNIQUE constraint on `workspace_path`, parallel
 * tests that all try to create spaces at the workspace root will race and conflict.
 *
 * This helper creates a unique subdirectory within the workspace root so each
 * test gets its own isolated path. The directory is created synchronously (Node.js
 * side) before the space is created via RPC.
 *
 * @param workspaceRoot - The base workspace root (from `getWorkspaceRoot(page)`)
 * @param prefix - Optional prefix for the subdirectory name (for easier debugging)
 * @returns The unique subdirectory path
 */
export function createUniqueSpaceDir(workspaceRoot: string, prefix = 'space'): string {
  const uniqueDir = join(
    workspaceRoot,
    `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
  );
  mkdirSync(uniqueDir, { recursive: true });
  return uniqueDir;
}
