import type { Page } from '@playwright/test';
import { test, expect } from '../../fixtures';
import {
  createSpace,
  deleteSpace,
  navigateToSpace,
  resetEditorModeStorage,
  openNewWorkflowEditor,
  switchToVisualMode,
  getDefaultAgentId,
} from '../helpers/workflow-editor-helpers';

const DESKTOP_VIEWPORT = { width: 1440, height: 900 };

async function createTestSpace(page: Page): Promise<string> {
  return createSpace(page, `E2E Visual Editor Test ${Date.now()}`);
}

async function deleteTestSpace(page: Page, spaceId: string): Promise<void> {
  return deleteSpace(page, spaceId);
}

test.describe('Visual Workflow Editor', () => {
  test.describe.configure({ mode: 'serial' });
  test.use({ viewport: DESKTOP_VIEWPORT });

  let spaceId = '';

  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await resetEditorModeStorage(page);
    spaceId = await createTestSpace(page);
  });

  test.afterEach(async ({ page }) => {
    if (spaceId) {
      await deleteTestSpace(page, spaceId);
      spaceId = '';
    }
  });

  test.skip('Create workflow with visual editor', async ({ page }) => {
    await navigateToSpace(page, spaceId);
    await openNewWorkflowEditor(page);
    await switchToVisualMode(page);

    const editor = page.getByTestId('visual-workflow-editor');

    await editor.getByTestId('workflow-name-input').fill('Visual Test Workflow');

    const addStepBtn = editor.getByTestId('add-step-button');
    await addStepBtn.click();
    await addStepBtn.click();
    await addStepBtn.click();

    const nodes = editor.locator('[data-testid^="workflow-node-"]');
    await expect(nodes).toHaveCount(3, { timeout: 3000 });

    await nodes.nth(0).click();
    await expect(editor.getByTestId('node-config-panel')).toBeVisible({ timeout: 3000 });
    await editor.getByTestId('step-name-input').fill('Planner');
    await editor.getByTestId('agent-select').selectOption({ index: 1 });
    await editor.getByTestId('close-button').click();
    await expect(editor.getByTestId('node-config-panel')).not.toBeVisible({ timeout: 2000 });

    await expect(
      editor
        .locator('[data-testid^="workflow-node-"]')
        .filter({ hasText: 'Planner' })
        .getByTestId('start-badge')
    ).toBeVisible({ timeout: 2000 });

    await nodes.nth(1).click();
    await expect(editor.getByTestId('node-config-panel')).toBeVisible({ timeout: 3000 });
    await editor.getByTestId('step-name-input').fill('Coder');
    await editor.getByTestId('agent-select').selectOption({ index: 1 });
    await editor.getByTestId('close-button').click();
    await expect(editor.getByTestId('node-config-panel')).not.toBeVisible({ timeout: 2000 });

    await nodes.nth(2).click();
    await expect(editor.getByTestId('node-config-panel')).toBeVisible({ timeout: 3000 });
    await editor.getByTestId('step-name-input').fill('Reviewer');
    await editor.getByTestId('agent-select').selectOption({ index: 1 });

    await expect(editor.getByTestId('set-as-start-button')).toBeVisible({ timeout: 2000 });
    await editor.getByTestId('set-as-start-button').click();

    await editor.getByTestId('close-button').click();
    await expect(editor.getByTestId('node-config-panel')).not.toBeVisible({ timeout: 2000 });

    await expect(
      editor
        .locator('[data-testid^="workflow-node-"]')
        .filter({ hasText: 'Reviewer' })
        .getByTestId('start-badge')
    ).toBeVisible({ timeout: 3000 });

    await expect(
      editor
        .locator('[data-testid^="workflow-node-"]')
        .filter({ hasText: 'Planner' })
        .getByTestId('start-badge')
    ).not.toBeVisible({ timeout: 2000 });

    await editor.getByTestId('save-button').click();

    await expect(page.getByTestId('editor-mode-toggle')).not.toBeVisible({ timeout: 5000 });
    await expect(page.locator('text=Visual Test Workflow')).toBeVisible({ timeout: 5000 });
  });

  test.skip('Node positions are restored after save and reopen', async ({ page }) => {
    await navigateToSpace(page, spaceId);

    const agentId = await getDefaultAgentId(page, spaceId);

    await page.evaluate(
      async ({ sid, aId }) => {
        const hub = window.__messageHub || window.appState?.messageHub;
        if (!hub?.request) throw new Error('Hub not available');
        const s1 = crypto.randomUUID();
        const s2 = crypto.randomUUID();
        const layout = {
          [s1]: { x: 100, y: 80 },
          [s2]: { x: 450, y: 80 },
        };
        await hub.request('spaceWorkflow.create', {
          spaceId: sid,
          name: 'Layout Persist Test',
          nodes: [
            { id: s1, name: 'Step One', agentId: aId },
            { id: s2, name: 'Step Two', agentId: aId },
          ],
          startNodeId: s1,
          rules: [],
          tags: [],
          layout,
          completionAutonomyLevel: 3,
        });
      },
      { sid: spaceId, aId: agentId }
    );

    await page.locator('text=Workflows').first().click();
    await expect(page.locator('text=Layout Persist Test')).toBeVisible({ timeout: 5000 });

    const workflowCard = page
      .locator('[class*="group"]')
      .filter({ has: page.locator('text=Layout Persist Test') })
      .first();
    await expect(workflowCard).toBeVisible({ timeout: 3000 });
    await workflowCard.evaluate((el) => {
      const actions = el.querySelector<HTMLElement>('[data-testid="workflow-card-actions"]');
      if (actions) actions.style.opacity = '1';
    });

    const editBtn = workflowCard.getByRole('button', { name: 'Edit' });
    await expect(editBtn).toBeVisible({ timeout: 3000 });
    await editBtn.click();

    await expect(page.getByTestId('editor-mode-toggle')).toBeVisible({ timeout: 5000 });

    await switchToVisualMode(page);

    const editor = page.getByTestId('visual-workflow-editor');

    await expect(editor.locator('[data-testid^="workflow-node-"]')).toHaveCount(2, {
      timeout: 5000,
    });

    await expect(editor.locator('text=Step One').first()).toBeVisible({ timeout: 3000 });
    await expect(editor.locator('text=Step Two').first()).toBeVisible({ timeout: 3000 });

    const nodeWithStepOne = editor
      .locator('[data-testid^="workflow-node-"]')
      .filter({ has: page.locator('text=Step One') });
    await expect(nodeWithStepOne.getByTestId('start-badge')).toBeVisible({ timeout: 3000 });

    const nodeOne = editor
      .locator('[data-testid^="workflow-node-"]')
      .filter({ has: page.locator('text=Step One') });
    const nodeTwo = editor
      .locator('[data-testid^="workflow-node-"]')
      .filter({ has: page.locator('text=Step Two') });
    const boxOne = await nodeOne.boundingBox();
    const boxTwo = await nodeTwo.boundingBox();
    expect(boxOne).not.toBeNull();
    expect(boxTwo).not.toBeNull();
    expect(Math.abs(boxTwo!.x - boxOne!.x)).toBeGreaterThan(50);

    await editor.getByTestId('save-button').click();
    await expect(page.getByTestId('editor-mode-toggle')).not.toBeVisible({ timeout: 5000 });
    await expect(page.locator('text=Layout Persist Test')).toBeVisible({ timeout: 5000 });
  });

  test.skip('Load template in visual editor', async ({ page }) => {
    await navigateToSpace(page, spaceId);
    await openNewWorkflowEditor(page);
    await switchToVisualMode(page);

    const editor = page.getByTestId('visual-workflow-editor');

    await expect(editor.getByTestId('template-picker-button')).toBeVisible({ timeout: 3000 });

    await editor.getByTestId('template-picker-button').click();

    await expect(editor.locator('[data-testid="template-option"]').first()).toBeVisible({
      timeout: 3000,
    });

    const codingTemplate = editor.locator('[data-template-label="Coding (Plan → Code)"]');
    await expect(codingTemplate).toBeVisible({ timeout: 3000 });
    await codingTemplate.click();

    const nodes = editor.locator('[data-testid^="workflow-node-"]');
    await expect(nodes).toHaveCount(2, { timeout: 5000 });

    await expect(editor.locator('text=Planner').first()).toBeVisible({ timeout: 3000 });
    await expect(editor.locator('text=Coder').first()).toBeVisible({ timeout: 3000 });

    await expect(editor.getByTestId('template-picker-button')).not.toBeVisible({
      timeout: 2000,
    });

    const nameValue = await editor.getByTestId('workflow-name-input').inputValue();
    expect(nameValue.length).toBeGreaterThan(0);

    await nodes.nth(0).click();
    await expect(editor.getByTestId('node-config-panel')).toBeVisible({ timeout: 3000 });
    await editor.getByTestId('agent-select').selectOption({ index: 1 });
    await editor.getByTestId('close-button').click();

    await nodes.nth(1).click();
    await expect(editor.getByTestId('node-config-panel')).toBeVisible({ timeout: 3000 });
    await editor.getByTestId('agent-select').selectOption({ index: 1 });
    await editor.getByTestId('close-button').click();

    await editor.getByTestId('save-button').click();

    await expect(page.getByTestId('editor-mode-toggle')).not.toBeVisible({ timeout: 5000 });
  });

  test('Create workflow opens visual editor directly', async ({ page }) => {
    await navigateToSpace(page, spaceId);

    await page.getByRole('button', { name: 'Configure space' }).click();
    await page.getByTestId('space-configure-tab-workflows').click();

    const createBtn = page.getByRole('button', { name: 'Create Workflow' });
    await expect(createBtn).toBeVisible({ timeout: 5000 });

    await createBtn.click();

    const editor = page.getByTestId('visual-workflow-editor');
    await expect(editor).toBeVisible({ timeout: 5000 });

    await expect(page.getByTestId('editor-mode-toggle')).not.toBeAttached();

    await expect(editor.getByTestId('workflow-name-input')).toBeVisible({ timeout: 3000 });
    await expect(editor.getByTestId('add-step-button')).toBeVisible({ timeout: 3000 });
  });

  test('Visual editor shows error when saving without name', async ({ page }) => {
    await navigateToSpace(page, spaceId);
    await openNewWorkflowEditor(page);
    await switchToVisualMode(page);

    const editor = page.getByTestId('visual-workflow-editor');

    await editor.getByTestId('add-step-button').click();
    await expect(editor.locator('[data-testid^="workflow-node-"]')).toHaveCount(1, {
      timeout: 3000,
    });

    await editor.getByTestId('save-button').click();

    await expect(page.locator('text=Workflow name is required')).toBeVisible({ timeout: 3000 });

    await expect(editor).toBeVisible();
  });

  test('Visual editor shows error when saving without agent assigned', async ({ page }) => {
    await navigateToSpace(page, spaceId);
    await openNewWorkflowEditor(page);
    await switchToVisualMode(page);

    const editor = page.getByTestId('visual-workflow-editor');

    await editor.getByTestId('workflow-name-input').fill('Test Validation Workflow');

    await editor.getByTestId('add-step-button').click();
    await expect(editor.locator('[data-testid^="workflow-node-"]')).toHaveCount(1, {
      timeout: 3000,
    });

    await editor.getByTestId('save-button').click();

    await expect(page.locator('text=requires an agent')).toBeVisible({ timeout: 3000 });

    await expect(editor).toBeVisible();
  });

  test.skip('Channel edges are visually distinct from transition edges', async ({ page }) => {
    await navigateToSpace(page, spaceId);

    const agentId = await getDefaultAgentId(page, spaceId);
    const s1 = crypto.randomUUID();
    const s2 = crypto.randomUUID();
    const t1 = crypto.randomUUID();

    await page.evaluate(
      async ({ sid, aId, step1, step2, trans1 }) => {
        const hub = window.__messageHub || window.appState?.messageHub;
        if (!hub?.request) throw new Error('Hub not available');
        await hub.request('spaceWorkflow.create', {
          spaceId: sid,
          name: 'Channel vs Transition Test',
          nodes: [
            {
              id: step1,
              name: 'Start',
              agentId: aId,
            },
            {
              id: step2,
              name: 'End',
              agentId: aId,
            },
          ],
          startNodeId: step1,
          rules: [],
          tags: [],
          layout: {
            [step1]: { x: 100, y: 80 },
            [step2]: { x: 450, y: 80 },
          },
          completionAutonomyLevel: 3,
        });
      },
      { sid: spaceId, aId: agentId, step1: s1, step2: s2, trans1: t1 }
    );

    await page.locator('text=Workflows').first().click();
    await expect(page.locator('text=Channel vs Transition Test')).toBeVisible({ timeout: 5000 });

    const workflowCard = page
      .locator('[class*="group"]')
      .filter({ has: page.locator('text=Channel vs Transition Test') })
      .first();
    await workflowCard.evaluate((el) => {
      const actions = el.querySelector<HTMLElement>('[data-testid="workflow-card-actions"]');
      if (actions) actions.style.opacity = '1';
    });
    await workflowCard.getByRole('button', { name: 'Edit' }).click();
    await expect(page.getByTestId('editor-mode-toggle')).toBeVisible({ timeout: 5000 });
    await switchToVisualMode(page);

    const editor = page.getByTestId('visual-workflow-editor');

    const transitionEdge = editor.locator(`[data-testid="edge-${t1}"]`);
    await expect(transitionEdge).toBeVisible({ timeout: 5000 });
    await expect(transitionEdge).toHaveAttribute('data-edge-id', t1);

    const transitionPath = transitionEdge.locator('path').first();
    const strokeDasharray = await transitionPath.getAttribute('stroke-dasharray');
    expect(strokeDasharray === null || strokeDasharray === '').toBe(true);

    const channelEdge = editor.locator('[data-channel-edge="true"]');
    await expect(channelEdge).toBeVisible({ timeout: 5000 });

    const channelPath = channelEdge.locator('path').last();
    const channelStrokeDasharray = await channelPath.getAttribute('stroke-dasharray');
    expect(channelStrokeDasharray).toMatch(/^\d+\s+\d+$/);
  });

  test.skip('Bidirectional channels show double-arrowhead edges on canvas', async ({ page }) => {
    await navigateToSpace(page, spaceId);
    await openNewWorkflowEditor(page);
    await switchToVisualMode(page);

    const editor = page.getByTestId('visual-workflow-editor');

    await editor.getByTestId('add-step-button').click();
    await expect(editor.locator('[data-testid^="workflow-node-"]')).toHaveCount(1, {
      timeout: 3000,
    });

    const node = editor.locator('[data-testid^="workflow-node-"]').nth(0);
    await node.click();
    await expect(editor.getByTestId('node-config-panel')).toBeVisible({ timeout: 3000 });
    await editor.getByTestId('agent-select').selectOption({ index: 1 });
    await editor.getByTestId('close-button').click();

    await expect(node.locator('text=↔')).toBeVisible({ timeout: 2000 });

    const channelEdge = editor.locator('[data-channel-edge="true"]');
    await expect(channelEdge).toBeVisible({ timeout: 3000 });

    const channelPath = channelEdge.locator('path:not([stroke="transparent"])');
    await expect(channelPath).toBeVisible({ timeout: 2000 });

    const markerEnd = await channelPath.getAttribute('marker-end');
    const markerStart = await channelPath.getAttribute('marker-start');
    expect(markerEnd).not.toBeNull();
    expect(markerStart).not.toBeNull();
    expect(markerEnd).toMatch(/url\(#.*arrow.*\)/i);
    expect(markerStart).toMatch(/url\(#.*arrow.*\)/i);
  });

  test.skip('One-way channels show single-arrowhead edges on canvas', async ({ page }) => {
    await navigateToSpace(page, spaceId);
    await openNewWorkflowEditor(page);
    await switchToVisualMode(page);

    const editor = page.getByTestId('visual-workflow-editor');

    await editor.getByTestId('add-step-button').click();
    await expect(editor.locator('[data-testid^="workflow-node-"]')).toHaveCount(1, {
      timeout: 3000,
    });

    const node = editor.locator('[data-testid^="workflow-node-"]').nth(0);
    await node.click();
    await expect(editor.getByTestId('node-config-panel')).toBeVisible({ timeout: 3000 });
    await editor.getByTestId('agent-select').selectOption({ index: 1 });

    const panel = editor.getByTestId('node-config-panel');

    const channelsSection = panel.getByTestId('add-channel-form');
    await expect(channelsSection).toBeVisible({ timeout: 2000 });

    await panel.locator('[data-testid="channel-from-select"]').selectOption({ label: 'Planner' });
    await panel
      .locator('[data-testid="channel-to-input"], [data-testid="channel-to-select"]')
      .fill('coder');

    await panel.getByTestId('add-channel-button').click();

    const channelEntry = panel
      .locator('[data-testid="channel-entry"]')
      .filter({ has: page.locator('text=→') });
    await expect(channelEntry).toBeVisible({ timeout: 2000 });

    await editor.getByTestId('close-button').click();

    const channelEdge = editor.locator('[data-channel-edge="true"]');
    await expect(channelEdge).toBeVisible({ timeout: 3000 });

    const channelPath = channelEdge.locator('path:not([stroke="transparent"])');
    await expect(channelPath).toBeVisible({ timeout: 2000 });

    const markerEnd = await channelPath.getAttribute('marker-end');
    const markerStart = await channelPath.getAttribute('marker-start');
    expect(markerEnd).not.toBeNull();
    expect(markerEnd).toMatch(/url\(#.*arrow.*\)/i);
    expect(markerStart === null || markerStart === '').toBe(true);
  });

  test.skip('Channel direction changes are reflected immediately in canvas', async ({ page }) => {
    await navigateToSpace(page, spaceId);
    await openNewWorkflowEditor(page);
    await switchToVisualMode(page);

    const editor = page.getByTestId('visual-workflow-editor');

    await editor.getByTestId('add-step-button').click();
    await expect(editor.locator('[data-testid^="workflow-node-"]')).toHaveCount(1, {
      timeout: 3000,
    });

    const node = editor.locator('[data-testid^="workflow-node-"]').nth(0);
    await node.click();
    await expect(editor.getByTestId('node-config-panel')).toBeVisible({ timeout: 3000 });
    await editor.getByTestId('agent-select').selectOption({ index: 1 });

    const panel = editor.getByTestId('node-config-panel');

    const channelsSection = panel.getByTestId('add-channel-form');
    await expect(channelsSection).toBeVisible({ timeout: 2000 });
    await panel.locator('[data-testid="channel-from-select"]').selectOption({ label: 'Planner' });
    await panel
      .locator('[data-testid="channel-to-input"], [data-testid="channel-to-select"]')
      .fill('coder');
    await panel.getByTestId('add-channel-button').click();

    const channelPath1 = editor
      .locator('[data-channel-edge="true"]')
      .locator('path:not([stroke="transparent"])');
    await expect(channelPath1).toBeVisible({ timeout: 2000 });
    const markerEnd1 = await channelPath1.getAttribute('marker-end');
    const markerStart1 = await channelPath1.getAttribute('marker-start');
    expect(markerEnd1).not.toBeNull();
    expect(markerStart1 === null || markerStart1 === '').toBe(true);

    const channelEntry = panel.locator('[data-testid="channel-entry"]').first();
    await expect(channelEntry).toBeVisible({ timeout: 2000 });

    const directionSelect = channelEntry.locator('select').first();
    if (await directionSelect.isVisible()) {
      await directionSelect.selectOption('bidirectional');
    } else {
      await channelEntry.locator('[data-testid="remove-channel-button"]').click();
      await panel.locator('[data-testid="channel-direction-select"]').selectOption('bidirectional');
      await panel.getByTestId('add-channel-button').click();
    }

    await page.waitForFunction(
      () => {
        const path = document.querySelector(
          '[data-channel-edge="true"] path:not([stroke="transparent"])'
        );
        if (!path) return false;
        const markerStart = path.getAttribute('marker-start');
        return markerStart !== null && markerStart !== '';
      },
      { timeout: 5000 }
    );

    const channelPath2 = editor
      .locator('[data-channel-edge="true"]')
      .locator('path:not([stroke="transparent"])');
    await expect(channelPath2).toBeVisible({ timeout: 2000 });
    const markerEnd2 = await channelPath2.getAttribute('marker-end');
    const markerStart2 = await channelPath2.getAttribute('marker-start');
    expect(markerEnd2).not.toBeNull();
    expect(markerStart2).not.toBeNull();
  });
});
