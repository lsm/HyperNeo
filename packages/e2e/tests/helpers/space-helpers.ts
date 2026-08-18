import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';

export async function createSpaceViaRpc(
  page: Page,
  workspacePath: string,
  name: string
): Promise<string> {
  const id = await page.evaluate(
    async ({ workspacePath, name }) => {
      const hub = window.__messageHub || window.appState?.messageHub;
      if (!hub?.request) throw new Error('MessageHub not available');
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

export function createUniqueSpaceDir(workspaceRoot: string, prefix = 'space'): string {
  const uniqueDir = join(
    workspaceRoot,
    `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
  );
  mkdirSync(uniqueDir, { recursive: true });
  return uniqueDir;
}
