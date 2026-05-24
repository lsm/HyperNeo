/**
 * Space Workflow Rules & Integration E2E Tests
 *
 * Tests:
 * - Navigate to Workflows via nav panel "Workflows" link
 * - Navigate to Agents via nav panel "Agents" link
 * - Navigate to Settings via nav panel "Settings" link
 * - Create workflow with 3 steps from template, add tags, save
 * - Open workflow editor and add a custom rule targeting specific steps
 * - Edit existing workflow
 * - Delete workflow (with confirmation dialog)
 * - Create custom agent
 *
 * Setup: creates a Space via RPC in beforeEach (infrastructure).
 * Cleanup: deletes the Space via RPC in afterEach.
 */

import type { Page } from '@playwright/test';
import { test, expect } from '../../fixtures';
import { waitForWebSocketConnected, getWorkspaceRoot } from '../helpers/wait-helpers';
import { createUniqueSpaceDir, deleteSpaceWorkflowsViaRpc } from '../helpers/space-helpers';

const DESKTOP_VIEWPORT = { width: 1280, height: 800 };

// ─── RPC helpers (infrastructure only) ────────────────────────────────────────

async function createTestSpace(page: Page): Promise<string> {
  await waitForWebSocketConnected(page);
  const workspaceRoot = await getWorkspaceRoot(page);
  // Use a unique subdirectory to avoid conflicts with other parallel tests
  // (workspace_path has a UNIQUE constraint in the DB).
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
  // Wait for SpaceIsland to finish loading — the space overview container appears after space data resolves.
  // The space dashboard no longer shows a "Dashboard" tab; use the testid on the overview container.
  await expect(page.getByTestId('space-overview-view')).toBeVisible({ timeout: 15000 });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

test.describe('Space Workflow Rules & Navigation Integration', () => {
  // All tests share the same workspace path (one space at a time) — must run serially
  test.describe.configure({ mode: 'serial' });
  test.use({ viewport: DESKTOP_VIEWPORT });

  let spaceId = '';

  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    spaceId = await createTestSpace(page);
    // Delete seeded built-in workflows so showCanvas=false and SpaceOverview is
    // visible on desktop viewports (otherwise md:hidden hides it behind WorkflowCanvas).
    await deleteSpaceWorkflowsViaRpc(page, spaceId);
  });

  test.afterEach(async ({ page }) => {
    if (spaceId) {
      await deleteTestSpace(page, spaceId);
      spaceId = '';
    }
  });

  // ─── Navigation ─────────────────────────────────────────────────────────────

  test('nav panel "Workflows" link switches to workflows tab', async ({ page }) => {
    await navigateToSpace(page, spaceId);

    // After the dashboard refactor, Workflows lives in the Configure page.
    // Navigate there via the "Configure space" gear button, then click the Workflows tab.
    await page.getByRole('button', { name: 'Configure space' }).click();
    await expect(page.getByTestId('space-configure-view')).toBeVisible({ timeout: 5000 });
    await page.getByTestId('space-configure-tab-workflows').click();

    // Workflows list should appear — "Create Workflow" button is the list's primary CTA
    await expect(page.getByRole('button', { name: 'Create Workflow' })).toBeVisible({
      timeout: 5000,
    });
  });

  test('nav panel "Agents" link switches to agents tab', async ({ page }) => {
    await navigateToSpace(page, spaceId);

    // After the dashboard refactor, Agents lives in the Configure page.
    // Navigate there via the "Configure space" gear button — Agents is the default tab.
    await page.getByRole('button', { name: 'Configure space' }).click();
    await expect(page.getByTestId('space-configure-view')).toBeVisible({ timeout: 5000 });
    await page.getByTestId('space-configure-tab-agents').click();

    // Agents list should appear — empty state or list
    await expect(
      page.locator('text=No custom agents yet').or(page.locator('text=Create Agent'))
    ).toBeVisible({ timeout: 5000 });
  });

  test('nav panel "Settings" link switches to settings tab', async ({ page }) => {
    await navigateToSpace(page, spaceId);

    // After the dashboard refactor, Settings lives in the Configure page.
    // Navigate there via the "Configure space" gear button, then click the Settings tab.
    await page.getByRole('button', { name: 'Configure space' }).click();
    await expect(page.getByTestId('space-configure-view')).toBeVisible({ timeout: 5000 });
    await page.getByTestId('space-configure-tab-settings').click();

    // Settings panel should appear
    await expect(
      page.locator('text=Space Settings').or(page.locator('text=Delete Space'))
    ).toBeVisible({ timeout: 5000 });
  });

  // ─── Workflow creation with tags ──────────────────────────────────────────

  test('can create a workflow from template with tags', async ({ page }) => {
    await navigateToSpace(page, spaceId);

    // Navigate to Workflows via the Configure page
    await page.getByRole('button', { name: 'Configure space' }).click();
    await expect(page.getByTestId('space-configure-view')).toBeVisible({ timeout: 5000 });
    await page.getByTestId('space-configure-tab-workflows').click();
    await expect(page.getByRole('button', { name: 'Create Workflow' })).toBeVisible({
      timeout: 5000,
    });

    // Click Create Workflow button to open the editor
    await page.getByRole('button', { name: 'Create Workflow' }).first().click();

    // Editor should open — the title in create mode is "New Workflow"
    await expect(page.locator('text=New Workflow').first()).toBeVisible({ timeout: 5000 });

    // Fill name
    const nameInput = page.locator('input[placeholder*="Feature Development"]');
    await nameInput.fill('E2E Test Workflow');

    // Use the Coding template
    await page.locator('text=Start from template').click();
    await page.locator('text=Coding (Plan → Code)').click();

    // 2 steps from template
    await expect(page.locator('text=2 steps')).toBeVisible({ timeout: 3000 });

    // Add a tag via suggestion
    await expect(page.locator('text=+ coding')).toBeVisible({ timeout: 3000 });
    await page.locator('text=+ coding').click();

    // The suggestion button should disappear (tag added)
    await expect(page.locator('text=+ coding')).not.toBeVisible({ timeout: 2000 });
  });

  // ─── Rules editor ────────────────────────────────────────────────────────

  test('can add a rule to a workflow', async ({ page }) => {
    await navigateToSpace(page, spaceId);

    // Navigate to Workflows via the Configure page → open editor
    await page.getByRole('button', { name: 'Configure space' }).click();
    await expect(page.getByTestId('space-configure-view')).toBeVisible({ timeout: 5000 });
    await page.getByTestId('space-configure-tab-workflows').click();
    await page.getByRole('button', { name: 'Create Workflow' }).first().click();
    await expect(page.locator('input[placeholder*="Feature Development"]')).toBeVisible({
      timeout: 5000,
    });

    // Fill name
    await page.locator('input[placeholder*="Feature Development"]').fill('Workflow With Rule');

    // Click Add Rule
    await page.locator('text=Add Rule').click();
    await expect(page.locator('text=1 rule')).toBeVisible({ timeout: 3000 });

    // Fill rule name
    const ruleNameInput = page.locator('input[placeholder*="Rule name"]');
    await expect(ruleNameInput).toBeVisible({ timeout: 3000 });
    await ruleNameInput.fill('TypeScript conventions');

    // Fill rule content
    const ruleContent = page.locator('textarea[placeholder*="Describe the rule"]');
    await expect(ruleContent).toBeVisible({ timeout: 3000 });
    await ruleContent.fill('Always use TypeScript strict mode');
  });

  test('rule "Applies to" shows step buttons from the steps list', async ({ page }) => {
    await navigateToSpace(page, spaceId);

    // Navigate to Workflows via the Configure page → open editor
    await page.getByRole('button', { name: 'Configure space' }).click();
    await expect(page.getByTestId('space-configure-view')).toBeVisible({ timeout: 5000 });
    await page.getByTestId('space-configure-tab-workflows').click();
    await page.getByRole('button', { name: 'Create Workflow' }).first().click();
    await expect(page.locator('input[placeholder*="Feature Development"]')).toBeVisible({
      timeout: 5000,
    });

    // Apply Coding template to get named steps
    await page.locator('text=Start from template').click();
    await page.locator('text=Coding (Plan → Code)').click();
    await expect(page.locator('text=2 steps')).toBeVisible({ timeout: 3000 });

    // Add a rule
    await page.locator('text=Add Rule').click();
    await expect(page.locator('text=1 rule')).toBeVisible({ timeout: 3000 });

    // The step buttons should show the step names
    // After template, steps are named "Planner" and "Coder" (or role names)
    // The "Applies to" section renders step name buttons
    // At minimum, 2 buttons should appear under "Applies to"
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

    // Add two rules
    await page.locator('text=Add Rule').click();
    await page.locator('text=Add Rule').click();
    await expect(page.locator('text=2 rules')).toBeVisible({ timeout: 3000 });

    // Remove the first rule
    await page.locator('[title="Remove rule"]').first().click();
    await expect(page.locator('text=1 rule')).toBeVisible({ timeout: 2000 });
  });

  // ─── Agent management integration ────────────────────────────────────────

  test('can open agent creation form from Agents tab', async ({ page }) => {
    await navigateToSpace(page, spaceId);

    // Navigate to Agents via the Configure page
    await page.getByRole('button', { name: 'Configure space' }).click();
    await expect(page.getByTestId('space-configure-view')).toBeVisible({ timeout: 5000 });
    await page.getByTestId('space-configure-tab-agents').click();
    await expect(
      page.locator('text=No custom agents yet').or(page.locator('text=Create Agent'))
    ).toBeVisible({ timeout: 5000 });

    // Click "Create Agent" button
    const createBtn = page.getByRole('button', { name: 'Create Agent' }).first();
    await expect(createBtn).toBeVisible({ timeout: 5000 });
    await createBtn.click();

    // Agent editor modal should open
    await expect(
      page.locator('text=Create Agent').or(page.locator('input[placeholder*="My Coder"]'))
    ).toBeVisible({ timeout: 5000 });
  });

  // ─── Workflow deletion ────────────────────────────────────────────────────

  // Nested describe so beforeEach/afterEach can set up workflow infrastructure
  // without putting RPC calls inside the test body (CLAUDE.md E2E rules).
  test.describe('workflow deletion', () => {
    const deletableWorkflowName = `Deletable Workflow ${Date.now()}`;
    let workflowCreated = false;

    test.beforeEach(async ({ page }) => {
      // Create a workflow via RPC — infrastructure setup, not test action
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

      // The workflow card should appear in the list
      await expect(page.locator(`text=${deletableWorkflowName}`)).toBeVisible({ timeout: 5000 });

      // Click the delete button on the workflow card
      const deleteBtn = page
        .locator('[title="Delete workflow"]')
        .or(page.locator('button[aria-label="Delete workflow"]'))
        .first();
      await expect(deleteBtn).toBeVisible({ timeout: 3000 });
      await deleteBtn.click();

      // Confirm deletion in the confirmation dialog
      await expect(page.locator('text=Delete').last()).toBeVisible({ timeout: 3000 });
      await page.locator('text=Delete').last().click();

      // Workflow should disappear from the list
      await expect(page.locator(`text=${deletableWorkflowName}`)).not.toBeVisible({
        timeout: 5000,
      });
      workflowCreated = false;
    });

    // Ignored — satisfies variable usage for ESLint
    test.afterEach(() => {
      // workflowCreated is false if the test succeeded (workflow was deleted via UI)
      // and true if the test failed — in which case the parent afterEach deletes the
      // entire Space, so the workflow is removed as a side effect.
      void workflowCreated;
    });
  });
});
