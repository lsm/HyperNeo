/**
 * Agent-Centric Workflow E2E Tests
 *
 * Tests the agent-centric collaboration workflow model features:
 * - Create channels between workflow steps via drag-and-drop on canvas
 * - Add gate condition to a channel via the channel relation config panel
 * - Agent completion state indicators on multi-agent canvas nodes
 * - Channel and gate persistence after save and reopen
 *
 * Setup: creates a Space with two agents via RPC in beforeEach (infrastructure).
 * Cleanup: deletes the Space via RPC in afterEach.
 *
 * E2E Rules:
 * - All test actions go through the UI (clicks, inputs, navigation)
 * - All assertions check visible DOM state
 * - RPC is only used in beforeEach/afterEach for test infrastructure
 */

import type { Page } from '@playwright/test';
import { test, expect } from '../../fixtures';
import { waitForWebSocketConnected } from '../helpers/wait-helpers';
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
  addGateToChannel,
  closeChannelPanel,
} from '../helpers/workflow-editor-helpers';

const DESKTOP_VIEWPORT = { width: 1440, height: 900 };

// ─── Agent roles used across tests ────────────────────────────────────────────

const ROLE_A = 'coder';
const ROLE_B = 'reviewer';
// Agent names use a distinct suffix to avoid conflicts with space pre-seeded agents
// (e.g. the seeded agent named 'coder'). These names become slot names in multi-agent
// steps.
const AGENT_A_NAME = 'Coder Agent';
const AGENT_B_NAME = 'Reviewer Agent';
// Option text as rendered by agent-select: just the agent name
const AGENT_A_OPTION = AGENT_A_NAME;
const AGENT_B_OPTION = AGENT_B_NAME;

// Step names used for channel-connected nodes
const STEP_A_NAME = 'Step A';
const STEP_B_NAME = 'Step B';

// ─── RPC helpers (infrastructure only) ────────────────────────────────────────

/**
 * Creates a space and two agents (coder, reviewer) for agent-centric test scenarios.
 */
async function createTestSpace(page: Page): Promise<string> {
  await waitForWebSocketConnected(page);
  const spaceName = `E2E Agent-Centric Workflow ${Date.now()}`;
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

/**
 * Helper to add a node with a given step name and configure two agents.
 * Returns the node locator.
 */
async function addMultiAgentNode(
  editor: import('@playwright/test').Locator,
  stepName: string
): Promise<import('@playwright/test').Locator> {
  const nodes = editor.locator('[data-testid^="workflow-node-"]');
  const countBefore = await nodes.count();

  await editor.getByTestId('add-step-button').click();

  // Wait for the new node to appear before selecting it
  await expect(nodes).toHaveCount(countBefore + 1, { timeout: 5000 });
  const newNode = nodes.nth(countBefore);
  await expect(newNode).toBeVisible({ timeout: 3000 });

  await newNode.click();
  const panel = editor.getByTestId('node-config-panel');
  await expect(panel).toBeVisible({ timeout: 3000 });
  await panel.getByTestId('step-name-input').fill(stepName);
  await setupMultiAgentStep(panel, AGENT_A_OPTION, AGENT_B_OPTION);
  await panel.getByTestId('close-button').click();
  await expect(panel).not.toBeVisible({ timeout: 2000 });

  return newNode;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

test.describe('Agent-Centric Workflow', () => {
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

  // ─── Test 1: Create channel between workflow steps ─────────────────────────

  test('Create channel between workflow steps via drag-and-drop', async ({ page }) => {
    await navigateToSpace(page, spaceId);
    await openNewWorkflowEditor(page);
    await switchToVisualMode(page);

    const editor = page.getByTestId('visual-workflow-editor');
    await editor.getByTestId('workflow-name-input').fill('Agent Channel Test');

    // Wait for the canvas to fully render
    await expect(editor.getByTestId('add-step-button')).toBeVisible({ timeout: 5000 });

    // Add two nodes with multi-agent config
    await addMultiAgentNode(editor, STEP_A_NAME);
    await addMultiAgentNode(editor, STEP_B_NAME);

    // Create a one-way channel by dragging from Step A's output port to Step B's input port
    await createChannelByDrag(editor, STEP_A_NAME, STEP_B_NAME);

    // Verify a channel edge appears on the canvas with one-way direction.
    // Channel edge test IDs use internal UUIDs, so we match by data attribute.
    const channelEdge = editor.locator('[data-channel-edge="true"]').first();
    await channelEdge.waitFor({ state: 'attached', timeout: 5000 });
    await expect(channelEdge).toHaveAttribute('data-channel-direction', 'one-way');
  });

  // ─── Test 2: Add gate condition to a channel ───────────────────────────────

  test('Add gate to channel — gate badge appears on canvas edge', async ({ page }) => {
    await navigateToSpace(page, spaceId);
    await openNewWorkflowEditor(page);
    await switchToVisualMode(page);

    const editor = page.getByTestId('visual-workflow-editor');
    await editor.getByTestId('workflow-name-input').fill('Gate Config Test');

    await expect(editor.getByTestId('add-step-button')).toBeVisible({ timeout: 5000 });

    // Add two nodes with multi-agent config
    await addMultiAgentNode(editor, STEP_A_NAME);
    await addMultiAgentNode(editor, STEP_B_NAME);

    // Create channel
    await createChannelByDrag(editor, STEP_A_NAME, STEP_B_NAME);

    // Click the channel edge to open the channel relation config panel
    await clickChannelEdge(editor);

    // Add a gate to the channel and verify it was created.
    // Gates have no "type" field — an empty gate is created first (no label, no fields).
    // Clicking "Add Gate" auto-opens the GateEditorPanel; go back to verify the gate exists.
    await addGateToChannel(editor);
    await expect(editor.getByTestId('gate-editor-panel')).toBeVisible({ timeout: 3000 });
    await editor.getByTestId('gate-editor-back').click();

    // After going back, the "Add Gate" button is replaced by "Edit Gate".
    const editGateBtn = editor.getByTestId(/^channel-edge-edit-gate-/);
    await expect(editGateBtn).toHaveCount(1, { timeout: 3000 });

    // Close the panel and verify the gate indicator appears on the canvas edge.
    await closeChannelPanel(editor);

    const gatedEdge = editor.locator('[data-channel-gated="true"]').first();
    await gatedEdge.waitFor({ state: 'attached', timeout: 5000 });
  });

  // ─── Test 3: Agent completion state indicators ────────────────────────────

  test('Multi-agent node renders agent badges and completion state structure', async ({ page }) => {
    await navigateToSpace(page, spaceId);
    await openNewWorkflowEditor(page);
    await switchToVisualMode(page);

    const editor = page.getByTestId('visual-workflow-editor');
    await editor.getByTestId('workflow-name-input').fill('Completion State Test');

    // Add a step with two agents
    await editor.getByTestId('add-step-button').click();
    const nodes = editor.locator('[data-testid^="workflow-node-"]');
    await expect(nodes).toHaveCount(1, { timeout: 3000 });

    await nodes.first().click();
    const panel = editor.getByTestId('node-config-panel');
    await expect(panel).toBeVisible({ timeout: 3000 });
    await panel.getByTestId('step-name-input').fill('Parallel Agents');
    await setupMultiAgentStep(panel, AGENT_A_OPTION, AGENT_B_OPTION);
    await panel.getByTestId('close-button').click();
    await expect(panel).not.toBeVisible({ timeout: 2000 });

    // The canvas node should show agent-badges with both agent names (slot names).
    const node = nodes.first();
    const agentBadges = node.getByTestId('agent-badges');
    await expect(agentBadges).toBeVisible({ timeout: 3000 });
    await expect(agentBadges.locator(`text=${AGENT_A_NAME}`)).toBeVisible({ timeout: 2000 });
    await expect(agentBadges.locator(`text=${AGENT_B_NAME}`)).toBeVisible({ timeout: 2000 });

    // Without an active workflow run, no completion state icons should be visible
    // (no agent-status-spinner, agent-status-check, or agent-status-fail)
    await expect(node.getByTestId('agent-status-spinner')).toHaveCount(0);
    await expect(node.getByTestId('agent-status-check')).toHaveCount(0);
    await expect(node.getByTestId('agent-status-fail')).toHaveCount(0);
  });

  // ─── Test 4: Channel and gate persist after save and reopen ───────────────

  // Tracking: https://github.com/lsm/neokai/issues/815 (save issue - editor does not close after clicking save)
  test.skip('Channel and gate configuration persist after save and reopen', async ({ page }) => {
    const WORKFLOW_NAME = `Channel Persist Test ${Date.now()}`;

    await navigateToSpace(page, spaceId);
    await openNewWorkflowEditor(page);
    await switchToVisualMode(page);

    const editor = page.getByTestId('visual-workflow-editor');
    await editor.getByTestId('workflow-name-input').fill(WORKFLOW_NAME);

    await expect(editor.getByTestId('add-step-button')).toBeVisible({ timeout: 5000 });

    // Add two nodes with multi-agent config
    await addMultiAgentNode(editor, STEP_A_NAME);
    await addMultiAgentNode(editor, STEP_B_NAME);

    // Create channel
    await createChannelByDrag(editor, STEP_A_NAME, STEP_B_NAME);

    // Add a gate to the channel
    await clickChannelEdge(editor);
    await addGateToChannel(editor);
    await closeChannelPanel(editor);

    // Verify gate is on the canvas (channel edge has gated attribute)
    const gatedEdge = editor.locator('[data-channel-gated="true"]').first();
    await gatedEdge.waitFor({ state: 'attached', timeout: 5000 });

    // Save workflow
    await editor.getByTestId('save-button').click();
    await expect(page.getByTestId('editor-mode-toggle')).not.toBeVisible({ timeout: 5000 });
    await expect(page.locator(`text=${WORKFLOW_NAME}`)).toBeVisible({ timeout: 5000 });

    // ── Reopen and verify channel + gate persist ────────────────────────────

    await openWorkflowForEdit(page, WORKFLOW_NAME);
    await switchToVisualMode(page);

    const editorReopen = page.getByTestId('visual-workflow-editor');

    // Channel edge should still be present (matched by data attribute, not step-name test ID)
    const persistedEdge = editorReopen.locator('[data-channel-edge="true"]').first();
    await persistedEdge.waitFor({ state: 'attached', timeout: 5000 });

    // Gate should persist
    const persistedGate = editorReopen.locator('[data-channel-gated="true"]').first();
    await persistedGate.waitFor({ state: 'attached', timeout: 5000 });
  });
});
