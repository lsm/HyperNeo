import * as fs from 'fs';
import type { Page } from '@playwright/test';
import { test, expect } from '../../fixtures';
import { waitForWebSocketConnected, getWorkspaceRoot, getModal } from '../helpers/wait-helpers';
import { createUniqueSpaceDir } from '../helpers/space-helpers';

const SPACE_NAME = 'E2E Export Import Space';

async function createTestSpace(page: Page): Promise<{
  spaceId: string;
  agentId: string;
  agentName: string;
}> {
  await waitForWebSocketConnected(page);
  const wsRoot = await getWorkspaceRoot(page);
  const workspacePath = createUniqueSpaceDir(wsRoot, 'export-import');
  return page.evaluate(
    async ({ workspacePath, name }) => {
      const hub = window.__messageHub || window.appState?.messageHub;
      if (!hub?.request) throw new Error('MessageHub not available');

      const spaceRes = await hub.request('space.create', {
        name,
        description: 'Test space for export/import E2E tests',
        workspacePath,
      });
      const spaceId = (spaceRes as { id: string }).id;

      const agentRes = await hub.request('spaceAgent.create', {
        spaceId,
        name: 'Test Coder',
        description: 'A test coder agent',
      });
      const agentId = (agentRes as { agent: { id: string } }).agent.id;

      return { spaceId, agentId, agentName: 'Test Coder' };
    },
    { workspacePath, name: SPACE_NAME }
  );
}

async function deleteTestSpace(page: Page, spaceId: string): Promise<void> {
  if (!spaceId) return;
  try {
    await page.evaluate(async (id) => {
      const hub = window.__messageHub || window.appState?.messageHub;
      if (!hub?.request) return;
      await hub.request('space.delete', { id });
    }, spaceId);
  } catch {}
}

async function injectImportFile(page: Page, bundle: unknown): Promise<void> {
  await page.evaluate((b) => {
    const originalCreate = document.createElement.bind(document);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (document as any).createElement = (tag: string, ...args: unknown[]) => {
      const el = originalCreate(tag as 'input', ...(args as []));
      if (tag === 'input') {
        const input = el as HTMLInputElement;
        const origClick = input.click.bind(input);
        input.click = () => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (document as any).createElement = originalCreate;

          const json = JSON.stringify(b);
          const file = new File([json], 'test.hyperneo.json', { type: 'application/json' });
          const dt = new DataTransfer();
          dt.items.add(file);
          Object.defineProperty(input, 'files', { value: dt.files, writable: false });
          input.dispatchEvent(new Event('change', { bubbles: true }));
          origClick();
        };
      }
      return el;
    };
  }, bundle);
}

async function navigateToSpaceAgents(page: Page, spaceId: string): Promise<void> {
  await page.goto(`/space/${spaceId}`);
  await expect(page.locator('h2:has-text("Agents")')).toBeVisible({ timeout: 10000 });
}

test.describe('Space Export/Import', () => {
  let spaceId = '';
  let agentName = '';

  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForWebSocketConnected(page);
    const data = await createTestSpace(page);
    spaceId = data.spaceId;
    agentName = data.agentName;
  });

  test.afterEach(async ({ page }) => {
    await deleteTestSpace(page, spaceId);
    spaceId = '';
  });

  test('export single agent triggers download with .hyperneo.json filename', async ({ page }) => {
    await navigateToSpaceAgents(page, spaceId);

    const agentRow = page.locator(`li:has-text("${agentName}")`);
    await expect(agentRow).toBeVisible({ timeout: 8000 });
    await agentRow.hover();

    const exportBtn = agentRow.locator('button:has-text("Export")');
    await expect(exportBtn).toBeVisible({ timeout: 3000 });

    const [download] = await Promise.all([page.waitForEvent('download'), exportBtn.click()]);

    expect(download.suggestedFilename()).toMatch(/\.hyperneo\.json$/);
    expect(download.suggestedFilename()).toContain('agents');
  });

  test('Export All button downloads agents bundle', async ({ page }) => {
    await navigateToSpaceAgents(page, spaceId);

    await expect(page.locator('button:has-text("Export All")')).toBeVisible({ timeout: 8000 });

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.locator('button:has-text("Export All")').click(),
    ]);

    expect(download.suggestedFilename()).toMatch(/\.hyperneo\.json$/);
    expect(download.suggestedFilename()).toContain('agents');

    const filePath = await download.path();
    if (filePath) {
      const content = fs.readFileSync(filePath, 'utf-8');
      const parsed = JSON.parse(content);
      expect(parsed).toHaveProperty('type', 'bundle');
      expect(parsed).toHaveProperty('version', 1);
      expect(parsed.agents).toBeInstanceOf(Array);
      expect(parsed.agents.length).toBeGreaterThan(0);
    }
  });

  test('import with no conflicts shows success toast', async ({ page }) => {
    const newAgentBundle = {
      version: 1,
      type: 'bundle',
      name: 'test bundle',
      agents: [
        {
          version: 1,
          type: 'agent',
          name: 'Imported Reviewer',
          description: 'A reviewer agent imported from a bundle',
          tools: [],
        },
      ],
      workflows: [],
      exportedAt: Date.now(),
    };

    await navigateToSpaceAgents(page, spaceId);
    await injectImportFile(page, newAgentBundle);

    await page.locator('button:has-text("Import")').click();

    await expect(getModal(page)).toBeVisible({ timeout: 5000 });
    await expect(page.locator('text=Import Preview')).toBeVisible();

    await expect(page.locator('text=Imported Reviewer')).toBeVisible();
    await expect(page.locator('text=new').first()).toBeVisible();

    await expect(page.locator('text=/Will import.*1.*agent/')).toBeVisible();

    await getModal(page).locator('button:has-text("Import")').click();

    await expect(page.locator('text=/Imported.*agent/')).toBeVisible({ timeout: 8000 });
  });

  test('import with conflict shows conflict resolution options', async ({ page }) => {
    const conflictBundle = {
      version: 1,
      type: 'bundle',
      name: 'conflict test bundle',
      agents: [
        {
          version: 1,
          type: 'agent',
          name: agentName,
          description: 'Duplicate agent',
          tools: [],
        },
      ],
      workflows: [],
      exportedAt: Date.now(),
    };

    await navigateToSpaceAgents(page, spaceId);
    await injectImportFile(page, conflictBundle);

    await page.locator('button:has-text("Import")').click();

    await expect(getModal(page)).toBeVisible({ timeout: 5000 });
    await expect(page.locator('text=conflict').first()).toBeVisible();

    const conflictSelect = page.locator(`select[aria-label*="${agentName}"]`);
    await expect(conflictSelect).toBeVisible();

    await expect(getModal(page).locator('button:has-text("Import")')).toBeDisabled();

    await conflictSelect.selectOption('rename');

    await expect(page.locator('text=/Will import.*1.*agent/')).toBeVisible();
    await expect(getModal(page).locator('button:has-text("Import")')).not.toBeDisabled();

    await getModal(page).locator('button:has-text("Import")').click();

    await expect(page.locator('text=/Imported.*agent/')).toBeVisible({ timeout: 8000 });
  });

  test('import bundle with agents and workflows shows both sections', async ({ page }) => {
    const bundleWithBoth = {
      version: 1,
      type: 'bundle',
      name: 'full bundle',
      agents: [
        {
          version: 1,
          type: 'agent',
          name: 'Bundle Agent',
          tools: [],
        },
      ],
      workflows: [
        {
          version: 1,
          type: 'workflow',
          name: 'Bundle Workflow',
          nodes: [
            {
              name: 'step-1',
              agentRef: 'Bundle Agent',
            },
          ],
          startNode: 'step-1',
          rules: [],
          tags: [],
        },
      ],
      exportedAt: Date.now(),
    };

    await navigateToSpaceAgents(page, spaceId);
    await injectImportFile(page, bundleWithBoth);

    await page.locator('button:has-text("Import")').click();

    await expect(getModal(page)).toBeVisible({ timeout: 5000 });
    await expect(page.locator('text=/Agents \\(1\\)/')).toBeVisible();
    await expect(page.locator('text=/Workflows \\(1\\)/')).toBeVisible();

    await expect(page.locator('text=Bundle Agent')).toBeVisible();
    await expect(page.locator('text=Bundle Workflow')).toBeVisible();

    await expect(page.locator('text=/Will import.*1.*agent.*1.*workflow/')).toBeVisible();

    await getModal(page).locator('button:has-text("Import")').click();

    await expect(page.locator('text=/Imported.*agent.*workflow/')).toBeVisible({ timeout: 8000 });
  });
});
