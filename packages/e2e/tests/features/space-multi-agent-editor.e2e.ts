import type { Page } from '@playwright/test';
import { test, expect } from '../../fixtures';
import { waitForWebSocketConnected, getWorkspaceRoot } from '../helpers/wait-helpers';
import {
  createSpace,
  deleteSpace,
  navigateToSpace,
  resetEditorModeStorage,
  openNewWorkflowEditor,
  switchToVisualMode,
  openWorkflowForEdit,
  setupMultiAgentStep,
  createChannelByDrag,
  clickChannelEdge,
  closeChannelPanel,
} from '../helpers/workflow-editor-helpers';

const DESKTOP_VIEWPORT = { width: 1440, height: 900 };

const ROLE_A = 'coder';
const ROLE_B = 'reviewer';
const AGENT_A_NAME = 'Coder Agent';
const AGENT_B_NAME = 'Reviewer Agent';
const AGENT_A_OPTION = AGENT_A_NAME;
const AGENT_B_OPTION = AGENT_B_NAME;

async function createTestSpace(page: Page): Promise<string> {
  await waitForWebSocketConnected(page);
  const workspaceRoot = await getWorkspaceRoot(page);
  const spaceName = `E2E Multi-Agent Editor ${Date.now()}`;
  const spaceId = await createSpace(page, spaceName);

  await page.evaluate(
    async ({ sid, roleA, roleB, agentAName, agentBName }) => {
      const hub = window.__messageHub || window.appState?.messageHub;
      if (!hub?.request) throw new Error('MessageHub not available');
      await hub.request('spaceAgent.create', {
        spaceId: sid,
        name: agentAName,
        role: roleA,
        description: '',
      });
      await hub.request('spaceAgent.create', {
        spaceId: sid,
        name: agentBName,
        role: roleB,
        description: '',
      });
    },
    {
      sid: spaceId,
      roleA: ROLE_A,
      roleB: ROLE_B,
      agentAName: AGENT_A_NAME,
      agentBName: AGENT_B_NAME,
    }
  );

  return spaceId;
}

test.describe('Multi-Agent Step Editor', () => {
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
      await deleteSpace(page, spaceId);
      spaceId = '';
    }
  });

  test('Edit step to add second agent — verify both agents appear as badges', async ({ page }) => {
    await navigateToSpace(page, spaceId);
    await openNewWorkflowEditor(page);
    await switchToVisualMode(page);

    const editor = page.getByTestId('visual-workflow-editor');
    await editor.getByTestId('workflow-name-input').fill('Multi-Agent Badges Test');

    await editor.getByTestId('add-step-button').click();
    const nodes = editor.locator('[data-testid^="workflow-node-"]');
    await expect(nodes).toHaveCount(1, { timeout: 3000 });

    await nodes.first().click();
    const panel = editor.getByTestId('node-config-panel');
    await expect(panel).toBeVisible({ timeout: 3000 });
    await panel.getByTestId('step-name-input').fill('Parallel Step');

    await setupMultiAgentStep(panel, AGENT_A_OPTION, AGENT_B_OPTION);

    const agentsList = panel.getByTestId('agents-list');
    await expect(agentsList.getByTestId('agent-entry')).toHaveCount(2, { timeout: 2000 });
    const roleInputs = agentsList.locator('[data-testid="agent-role-input"]');
    await expect(roleInputs.first()).toHaveValue(AGENT_A_NAME, { timeout: 2000 });
    await expect(roleInputs.nth(1)).toHaveValue(AGENT_B_NAME, { timeout: 2000 });

    await panel.getByTestId('close-button').click();
    await expect(panel).not.toBeVisible({ timeout: 2000 });

    const freshNodes = editor.locator('[data-testid^="workflow-node-"]');
    const regularNode = freshNodes.nth(0);
    const agentBadges = regularNode.getByTestId('agent-badges');
    await expect(agentBadges).toBeVisible({ timeout: 3000 });
    await expect(agentBadges.locator(`text=${AGENT_A_NAME}`)).toBeVisible({ timeout: 2000 });
    await expect(agentBadges.locator(`text=${AGENT_B_NAME}`)).toBeVisible({ timeout: 2000 });
  });

  test('Add one-way channel between steps — verify directed arrow on canvas', async ({ page }) => {
    await navigateToSpace(page, spaceId);
    await openNewWorkflowEditor(page);
    await switchToVisualMode(page);

    const editor = page.getByTestId('visual-workflow-editor');
    await editor.getByTestId('workflow-name-input').fill('Channel Topology Test');

    const STEP_A = 'Step A';
    const STEP_B = 'Step B';

    await editor.getByTestId('add-step-button').click();
    let regularNodes = editor.locator('[data-testid^="workflow-node-"]');
    await expect(regularNodes).toHaveCount(1, { timeout: 3000 });
    await regularNodes.first().click();
    let panel = editor.getByTestId('node-config-panel');
    await expect(panel).toBeVisible({ timeout: 3000 });
    await panel.getByTestId('step-name-input').fill(STEP_A);
    await setupMultiAgentStep(panel, AGENT_A_OPTION, AGENT_B_OPTION);
    await panel.getByTestId('close-button').click();
    await expect(panel).not.toBeVisible({ timeout: 2000 });

    await editor.getByTestId('add-step-button').click();
    regularNodes = editor.locator('[data-testid^="workflow-node-"]');
    await expect(regularNodes).toHaveCount(2, { timeout: 3000 });
    await regularNodes.nth(1).click();
    panel = editor.getByTestId('node-config-panel');
    await expect(panel).toBeVisible({ timeout: 3000 });
    await panel.getByTestId('step-name-input').fill(STEP_B);
    await setupMultiAgentStep(panel, AGENT_A_OPTION, AGENT_B_OPTION);
    await panel.getByTestId('close-button').click();
    await expect(panel).not.toBeVisible({ timeout: 2000 });

    await createChannelByDrag(editor, STEP_A, STEP_B);

    const channelEdge = editor.locator('[data-channel-edge="true"]').first();
    await channelEdge.waitFor({ state: 'attached', timeout: 5000 });
    await expect(channelEdge).toHaveAttribute('data-channel-direction', 'one-way');

    await clickChannelEdge(editor);
    const configPanel = editor.getByTestId('channel-relation-config-panel');
    await expect(configPanel).toBeVisible({ timeout: 3000 });
    await expect(configPanel).toContainText(STEP_A);
    await expect(configPanel).toContainText(STEP_B);
  });

  test('Remove one agent from a node — channel between nodes persists', async ({ page }) => {
    await navigateToSpace(page, spaceId);
    await openNewWorkflowEditor(page);
    await switchToVisualMode(page);

    const editor = page.getByTestId('visual-workflow-editor');
    await editor.getByTestId('workflow-name-input').fill('Remove Agent Test');

    const STEP_A = 'Step A';
    const STEP_B = 'Step B';

    await editor.getByTestId('add-step-button').click();
    let regularNodes = editor.locator('[data-testid^="workflow-node-"]');
    await expect(regularNodes).toHaveCount(1, { timeout: 3000 });
    await regularNodes.first().click();
    let panel = editor.getByTestId('node-config-panel');
    await expect(panel).toBeVisible({ timeout: 3000 });
    await panel.getByTestId('step-name-input').fill(STEP_A);
    await setupMultiAgentStep(panel, AGENT_A_OPTION, AGENT_B_OPTION);
    await panel.getByTestId('close-button').click();
    await expect(panel).not.toBeVisible({ timeout: 2000 });

    await editor.getByTestId('add-step-button').click();
    regularNodes = editor.locator('[data-testid^="workflow-node-"]');
    await expect(regularNodes).toHaveCount(2, { timeout: 3000 });
    await regularNodes.nth(1).click();
    panel = editor.getByTestId('node-config-panel');
    await expect(panel).toBeVisible({ timeout: 3000 });
    await panel.getByTestId('step-name-input').fill(STEP_B);
    await setupMultiAgentStep(panel, AGENT_A_OPTION, AGENT_B_OPTION);
    await panel.getByTestId('close-button').click();
    await expect(panel).not.toBeVisible({ timeout: 2000 });

    await createChannelByDrag(editor, STEP_A, STEP_B);
    const channelEdge = editor.locator('[data-channel-edge="true"]').first();
    await channelEdge.waitFor({ state: 'attached', timeout: 5000 });

    regularNodes = editor.locator('[data-testid^="workflow-node-"]');
    await regularNodes.first().click();
    const reopenedPanel = editor.getByTestId('node-config-panel');
    await expect(reopenedPanel).toBeVisible({ timeout: 3000 });

    const agentsList = reopenedPanel.getByTestId('agents-list');
    const secondAgentEntry = agentsList.getByTestId('agent-entry').nth(1);
    await secondAgentEntry.getByTestId('remove-agent-button').click();

    await expect(reopenedPanel.getByTestId('agent-select')).toBeVisible({ timeout: 3000 });
    const selectedOption = reopenedPanel.getByTestId('agent-select').locator('option:checked');
    await expect(selectedOption).toHaveText(AGENT_A_NAME, { timeout: 2000 });
    await expect(reopenedPanel.getByTestId('add-agent-button')).toBeVisible({ timeout: 2000 });

    await channelEdge.waitFor({ state: 'attached', timeout: 3000 });
  });

  test.skip('Save workflow and reopen — multi-agent config and channel topology persist', async ({
    page,
  }) => {
    const WORKFLOW_NAME = `Persist Test ${Date.now()}`;

    await navigateToSpace(page, spaceId);
    await openNewWorkflowEditor(page);
    await switchToVisualMode(page);

    const editor = page.getByTestId('visual-workflow-editor');
    await editor.getByTestId('workflow-name-input').fill(WORKFLOW_NAME);

    await editor.getByTestId('add-step-button').click();
    const nodes = editor.locator('[data-testid^="workflow-node-"]');
    await nodes.nth(0).click();
    const panel = editor.getByTestId('node-config-panel');
    await expect(panel).toBeVisible({ timeout: 3000 });
    await panel.getByTestId('step-name-input').fill('Persist Step');
    await panel.getByTestId('agent-select').selectOption({ index: 1 });

    await panel.getByTestId('close-button').click();
    await expect(panel).not.toBeVisible({ timeout: 2000 });

    await editor.getByTestId('save-button').click();
    await expect(page.getByTestId('editor-mode-toggle')).not.toBeVisible({ timeout: 5000 });
    await expect(page.locator(`text=${WORKFLOW_NAME}`)).toBeVisible({ timeout: 5000 });

    await openWorkflowForEdit(page, WORKFLOW_NAME);
    await switchToVisualMode(page);

    const editorReopen = page.getByTestId('visual-workflow-editor');
    const reopenedNodes = editorReopen.locator('[data-testid^="workflow-node-"]');
    await expect(reopenedNodes).toHaveCount(1, { timeout: 5000 });

    const regularNode = reopenedNodes.nth(0);
    const agentName = regularNode.getByTestId('agent-name');
    await expect(agentName).toBeVisible({ timeout: 3000 });
  });
});
