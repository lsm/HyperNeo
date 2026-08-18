import type { Page } from '@playwright/test';
import { test, expect } from '../../fixtures';
import { waitForWebSocketConnected, getWorkspaceRoot } from '../helpers/wait-helpers';
import { createUniqueSpaceDir, deleteSpaceWorkflowsViaRpc } from '../helpers/space-helpers';

const DESKTOP_VIEWPORT = { width: 1280, height: 800 };

async function createTestSpace(page: Page): Promise<string> {
  await waitForWebSocketConnected(page);
  const workspaceRoot = await getWorkspaceRoot(page);
  const wsPath = createUniqueSpaceDir(workspaceRoot, 'workflow-rules');
  const spaceName = `E2E Rules Test Space ${Date.now()}`;
  return page.evaluate(
    async ({ wsPath, name }) => {
      const hub = window.__messageHub || window.appState?.messageHub;
      if (!hub?.request) throw new Error('MessageHub not available');

      const res = await hub.request('space.create', {
        name,
        workspacePath: wsPath,
      });
      return (res as { id: string }).id;
    },
    { wsPath, name: spaceName }
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
  } catch {
    // Best-effort cleanup
  }
}

async function navigateToSpace(page: Page, spaceId: string): Promise<void> {
  await page.goto(`/space/${spaceId}`);
  await page.waitForURL(`/space/${spaceId}**`, { timeout: 10000 });
  await expect(page.getByTestId('space-overview-view')).toBeVisible({ timeout: 15000 });
}

test.describe('Space Workflow Rules & Navigation Integration', () => {
  test.describe.configure({ mode: 'serial' });
  test.use({ viewport: DESKTOP_VIEWPORT });

  let spaceId = '';

  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    spaceId = await createTestSpace(page);
    await deleteSpaceWorkflowsViaRpc(page, spaceId);
  });

  test.afterEach(async ({ page }) => {
    if (spaceId) {
      await deleteTestSpace(page, spaceId);
      spaceId = '';
    }
  });

  test('nav panel "Workflows" link switches to workflows tab', async ({ page }) => {
    await navigateToSpace(page, spaceId);

    await page.getByRole('button', { name: 'Configure space' }).click();
    await expect(page.getByTestId('space-configure-view')).toBeVisible({ timeout: 5000 });
    await page.getByTestId('space-configure-tab-workflows').click();

    await expect(page.getByRole('button', { name: 'Create Workflow' })).toBeVisible({
      timeout: 5000,
    });
  });

  test('nav panel "Agents" link switches to agents tab', async ({ page }) => {
    await navigateToSpace(page, spaceId);

    await page.getByRole('button', { name: 'Configure space' }).click();
    await expect(page.getByTestId('space-configure-view')).toBeVisible({ timeout: 5000 });
    await page.getByTestId('space-configure-tab-agents').click();

    await expect(
      page.locator('text=No custom agents yet').or(page.locator('text=Create Agent'))
    ).toBeVisible({ timeout: 5000 });
  });

  test('nav panel "Settings" link switches to settings tab', async ({ page }) => {
    await navigateToSpace(page, spaceId);

    await page.getByRole('button', { name: 'Configure space' }).click();
    await expect(page.getByTestId('space-configure-view')).toBeVisible({ timeout: 5000 });
    await page.getByTestId('space-configure-tab-settings').click();

    await expect(
      page.locator('text=Space Settings').or(page.locator('text=Delete Space'))
    ).toBeVisible({ timeout: 5000 });
  });

  test('can create a workflow from template with tags', async ({ page }) => {
    await navigateToSpace(page, spaceId);

    await page.getByRole('button', { name: 'Configure space' }).click();
    await expect(page.getByTestId('space-configure-view')).toBeVisible({ timeout: 5000 });
    await page.getByTestId('space-configure-tab-workflows').click();
    await expect(page.getByRole('button', { name: 'Create Workflow' })).toBeVisible({
      timeout: 5000,
    });

    await page.getByRole('button', { name: 'Create Workflow' }).first().click();

    await expect(page.locator('text=New Workflow').first()).toBeVisible({ timeout: 5000 });

    const nameInput = page.locator('input[placeholder*="Feature Development"]');
    await nameInput.fill('E2E Test Workflow');

    await page.locator('text=Start from template').click();
    await page.locator('text=Coding (Plan → Code)').click();

    await expect(page.locator('text=2 steps')).toBeVisible({ timeout: 3000 });

    await expect(page.locator('text=+ coding')).toBeVisible({ timeout: 3000 });
    await page.locator('text=+ coding').click();

    await expect(page.locator('text=+ coding')).not.toBeVisible({ timeout: 2000 });
  });

  test('can add a rule to a workflow', async ({ page }) => {
    await navigateToSpace(page, spaceId);

    await page.getByRole('button', { name: 'Configure space' }).click();
    await expect(page.getByTestId('space-configure-view')).toBeVisible({ timeout: 5000 });
    await page.getByTestId('space-configure-tab-workflows').click();
    await page.getByRole('button', { name: 'Create Workflow' }).first().click();
    await expect(page.locator('input[placeholder*="Feature Development"]')).toBeVisible({
      timeout: 5000,
    });

    await page.locator('input[placeholder*="Feature Development"]').fill('Workflow With Rule');

    await page.locator('text=Add Rule').click();
    await expect(page.locator('text=1 rule')).toBeVisible({ timeout: 3000 });

    const ruleNameInput = page.locator('input[placeholder*="Rule name"]');
    await expect(ruleNameInput).toBeVisible({ timeout: 3000 });
    await ruleNameInput.fill('TypeScript conventions');

    const ruleContent = page.locator('textarea[placeholder*="Describe the rule"]');
    await expect(ruleContent).toBeVisible({ timeout: 3000 });
    await ruleContent.fill('Always use TypeScript strict mode');
  });

  test('rule "Applies to" shows step buttons from the steps list', async ({ page }) => {
    await navigateToSpace(page, spaceId);

    await page.getByRole('button', { name: 'Configure space' }).click();
    await expect(page.getByTestId('space-configure-view')).toBeVisible({ timeout: 5000 });
    await page.getByTestId('space-configure-tab-workflows').click();
    await page.getByRole('button', { name: 'Create Workflow' }).first().click();
    await expect(page.locator('input[placeholder*="Feature Development"]')).toBeVisible({
      timeout: 5000,
    });

    await page.locator('text=Start from template').click();
    await page.locator('text=Coding (Plan → Code)').click();
    await expect(page.locator('text=2 steps')).toBeVisible({ timeout: 3000 });

    await page.locator('text=Add Rule').click();
    await expect(page.locator('text=1 rule')).toBeVisible({ timeout: 3000 });

    const appliesToSection = page.locator('text=Applies to').first();
    await expect(appliesToSection).toBeVisible({ timeout: 3000 });
  });

  test('removing a rule decrements rule count', async ({ page }) => {
    await navigateToSpace(page, spaceId);

    await page.getByRole('button', { name: 'Configure space' }).click();
    await expect(page.getByTestId('space-configure-view')).toBeVisible({ timeout: 5000 });
    await page.getByTestId('space-configure-tab-workflows').click();
    await page.getByRole('button', { name: 'Create Workflow' }).first().click();
    await expect(page.locator('input[placeholder*="Feature Development"]')).toBeVisible({
      timeout: 5000,
    });

    await page.locator('text=Add Rule').click();
    await page.locator('text=Add Rule').click();
    await expect(page.locator('text=2 rules')).toBeVisible({ timeout: 3000 });

    await page.locator('[title="Remove rule"]').first().click();
    await expect(page.locator('text=1 rule')).toBeVisible({ timeout: 2000 });
  });

  test('can open agent creation form from Agents tab', async ({ page }) => {
    await navigateToSpace(page, spaceId);

    await page.getByRole('button', { name: 'Configure space' }).click();
    await expect(page.getByTestId('space-configure-view')).toBeVisible({ timeout: 5000 });
    await page.getByTestId('space-configure-tab-agents').click();
    await expect(
      page.locator('text=No custom agents yet').or(page.locator('text=Create Agent'))
    ).toBeVisible({ timeout: 5000 });

    const createBtn = page.getByRole('button', { name: 'Create Agent' }).first();
    await expect(createBtn).toBeVisible({ timeout: 5000 });
    await createBtn.click();

    await expect(
      page.locator('text=Create Agent').or(page.locator('input[placeholder*="My Coder"]'))
    ).toBeVisible({ timeout: 5000 });
  });

  test.describe('workflow deletion', () => {
    const deletableWorkflowName = `Deletable Workflow ${Date.now()}`;
    let workflowCreated = false;

    test.beforeEach(async ({ page }) => {
      await page.evaluate(
        async ({ sid, wname }) => {
          const hub = window.__messageHub || window.appState?.messageHub;
          if (!hub?.request) throw new Error('Hub not available');

          const agentsRes = await hub.request('spaceAgent.list', { spaceId: sid });
          const agents = (agentsRes as { agents: Array<{ id: string; name: string }> }).agents;
          const planner = agents.find((a) => a.name === 'Planner') ?? agents[0];
          if (!planner) throw new Error('No agents seeded in space');

          const node = {
            id: crypto.randomUUID(),
            name: 'Node 1',
            agents: [{ agentId: planner.id, name: 'Planner' }],
          };
          await hub.request('spaceWorkflow.create', {
            spaceId: sid,
            name: wname,
            nodes: [node],
            startNodeId: node.id,
            rules: [],
            tags: [],
            completionAutonomyLevel: 3,
          });
        },
        { sid: spaceId, wname: deletableWorkflowName }
      );
      workflowCreated = true;
    });

    test('can delete a workflow via list UI', async ({ page }) => {
      await navigateToSpace(page, spaceId);
      await page.getByRole('button', { name: 'Configure space' }).click();
      await expect(page.getByTestId('space-configure-view')).toBeVisible({ timeout: 5000 });
      await page.getByTestId('space-configure-tab-workflows').click();

      await expect(page.locator(`text=${deletableWorkflowName}`)).toBeVisible({ timeout: 5000 });

      const deleteBtn = page
        .locator('[title="Delete workflow"]')
        .or(page.locator('button[aria-label="Delete workflow"]'))
        .first();
      await expect(deleteBtn).toBeVisible({ timeout: 3000 });
      await deleteBtn.click();

      await expect(page.locator('text=Delete').last()).toBeVisible({ timeout: 3000 });
      await page.locator('text=Delete').last().click();

      await expect(page.locator(`text=${deletableWorkflowName}`)).not.toBeVisible({
        timeout: 5000,
      });
      workflowCreated = false;
    });

    test.afterEach(() => {
      void workflowCreated;
    });
  });
});
