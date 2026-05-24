/**
 * Script Gate Configuration E2E Tests
 *
 * Tests script-based gate configuration in the visual workflow editor:
 * - Configure interpreter to "node" and set script source
 * - Verify the gate badge shows the script icon ⚡ on the canvas
 * - Verify gate configuration persists after save and reopen (including timeout)
 *
 * Architecture notes:
 *   Gate evaluation (script execution, open/blocked state) is handled by the backend
 *   and covered by unit tests (gate-script-executor.test.ts) and integration tests
 *   (channel-router-async.test.ts). Preset script behavior is covered by
 *   space-gate-custom-badges.e2e.ts. This E2E test focuses on the unique concern
 *   of save/reopen persistence for script gate configuration.
 *
 * Setup:
 *   - Space is created via RPC in beforeEach (infrastructure).
 *
 * Cleanup:
 *   - Space is deleted via RPC in afterEach.
 *
 * E2E Rules:
 *   - All test actions go through the UI (clicks, inputs, navigation).
 *   - All assertions check visible DOM state (badge SVG text, panel fields, testids).
 *   - RPC is only used in beforeEach / afterEach for infrastructure setup / teardown.
 *
 * Interpreter constraint:
 *   - Only `node` interpreter is used in this test (no python3/bash dependency).
 *
 * UI Flow:
 *   Create space → Open visual editor → Add 2 steps → Port-drag to create channel →
 *   Node click → NodeConfigPanel → channel-link button → ChannelRelationConfigPanel →
 *   "Add Gate" → GateEditorPanel → Toggle script → Set interpreter/source → Verify badge
 */

import type { Page } from '@playwright/test';
import { test, expect } from '../../fixtures';
import {
  createSpace,
  deleteSpace,
  navigateToSpace,
  resetEditorModeStorage,
  openNewWorkflowEditor,
  switchToVisualMode,
  openWorkflowForEdit,
} from '../helpers/workflow-editor-helpers';

const DESKTOP_VIEWPORT = { width: 1440, height: 900 };

// ─── Script configuration ─────────────────────────────────────────────────────

const SCRIPT_SOURCE = 'console.log(JSON.stringify({ done: true }))';
const DEFAULT_SCRIPT_TIMEOUT = '30';

// ─── UI action helpers ────────────────────────────────────────────────────────

/**
 * Sets up a workflow with two steps connected by a channel that has a script gate.
 *
 * Preconditions:
 *   - Space is created
 *   - Page is navigated to the space
 *
 * Postconditions:
 *   - Visual workflow editor is open with 2 named steps
 *   - A one-way channel exists from step 1 (Plan Step) to step 2 (Code Step)
 *   - A script gate is configured on the channel with the given interpreter and source
 *   - NodeConfigPanel is closed
 *
 * @returns The workflow name (for later save/reopen verification)
 */
async function setupWorkflowWithScriptGate(
  page: Page,
  scriptSource: string,
  interpreter = 'node'
): Promise<string> {
  await openNewWorkflowEditor(page);
  await switchToVisualMode(page);

  const editor = page.getByTestId('visual-workflow-editor');
  const workflowName = `Script Gate Workflow ${Date.now()}`;
  await editor.getByTestId('workflow-name-input').fill(workflowName);

  // Add step 1 (auto-designated as start node)
  await editor.getByTestId('add-step-button').click();
  const regularNodes = () => editor.locator('[data-testid^="workflow-node-"]');
  await expect(regularNodes()).toHaveCount(1, { timeout: 3000 });

  // Name step 1
  const step1 = regularNodes().first();
  await step1.click();
  const panel1 = editor.getByTestId('node-config-panel');
  await expect(panel1).toBeVisible({ timeout: 3000 });
  await panel1.getByTestId('step-name-input').fill('Plan Step');
  await panel1.getByTestId('agent-select').selectOption({ label: 'Planner Agent' });
  await panel1.getByTestId('close-button').click();
  await expect(panel1).not.toBeVisible({ timeout: 2000 });

  // Add step 2
  await editor.getByTestId('add-step-button').click();
  await expect(regularNodes()).toHaveCount(2, { timeout: 3000 });

  // Name step 2
  const step2 = regularNodes().nth(1);
  await step2.click();
  const panel2 = editor.getByTestId('node-config-panel');
  await expect(panel2).toBeVisible({ timeout: 3000 });
  await panel2.getByTestId('step-name-input').fill('Code Step');
  await panel2.getByTestId('agent-select').selectOption({ label: 'Coder Agent' });
  await panel2.getByTestId('close-button').click();
  await expect(panel2).not.toBeVisible({ timeout: 2000 });

  // Create a channel by dragging from step 1's output port to step 2's input port
  await step1.getByTestId('port-output').dragTo(step2.getByTestId('port-input'));
  await expect(editor.locator('[data-testid^="channel-edge-"]')).toHaveCount(1, { timeout: 5000 });

  // Open GateEditorPanel for the channel
  await step1.click();
  const nodePanel = editor.getByTestId('node-config-panel');
  await expect(nodePanel).toBeVisible({ timeout: 3000 });

  const channelLinkButton = nodePanel.getByTestId('node-channel-link-button');
  await expect(channelLinkButton).toBeVisible({ timeout: 5000 });
  await channelLinkButton.click();

  const relationPanel = nodePanel.getByTestId('channel-relation-config-panel');
  await expect(relationPanel).toBeVisible({ timeout: 5000 });

  await relationPanel.getByTestId('channel-edge-add-gate-0').click();

  const gatePanel = nodePanel.getByTestId('gate-editor-panel');
  await expect(gatePanel).toBeVisible({ timeout: 5000 });

  // Configure the script gate
  const scriptToggle = gatePanel.getByTestId('gate-editor-script-enabled');
  await scriptToggle.click();
  await expect(scriptToggle).toHaveAttribute('aria-checked', 'true');

  const interpreterSelect = gatePanel.getByTestId('gate-editor-script-interpreter');
  await expect(interpreterSelect).toBeVisible({ timeout: 3000 });
  await interpreterSelect.selectOption({ value: interpreter });

  const sourceTextarea = gatePanel.getByTestId('gate-editor-script-source');
  await expect(sourceTextarea).toBeVisible({ timeout: 2000 });
  await sourceTextarea.fill(scriptSource);

  // Verify no gate completeness error
  const gateError = gatePanel.getByTestId('gate-editor-gate-error');
  await expect(gateError).not.toBeVisible({ timeout: 2000 });

  // Close all panels
  await nodePanel.getByTestId('close-button').click();
  await expect(nodePanel).not.toBeVisible({ timeout: 2000 });

  return workflowName;
}

/**
 * Returns a locator for the first gate badge on the canvas SVG.
 * Uses a prefix match since the badge testid includes step IDs (UUIDs).
 */
function getFirstGateBadge(page: Page) {
  return page.locator('[data-testid^="channel-gate-"]').first();
}

// ─── Tests ────────────────────────────────────────────────────────────────────

test.describe('Script Gate Configuration', () => {
  // Serial mode is required because tests share describe-scoped spaceId state
  // via beforeEach/afterEach, and parallel execution causes workspace_path collisions.
  test.describe.configure({ mode: 'serial' });
  test.use({ viewport: DESKTOP_VIEWPORT });

  let spaceId = '';

  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await resetEditorModeStorage(page);
    const spaceName = `E2E Script Gate ${Date.now()}`;
    spaceId = await createSpace(page, spaceName);

    // Create two agents so workflow steps can be assigned (required for save).
    await page.evaluate(
      async ({ sid }) => {
        const hub = window.__messageHub || window.appState?.messageHub;
        if (!hub?.request) throw new Error('MessageHub not available');
        await hub.request('spaceAgent.create', {
          spaceId: sid,
          name: 'Planner Agent',
          role: 'planner',
          description: 'Planning agent for script gate tests',
        });
        await hub.request('spaceAgent.create', {
          spaceId: sid,
          name: 'Coder Agent',
          role: 'coder',
          description: 'Coding agent for script gate tests',
        });
      },
      { sid: spaceId }
    );
  });

  test.afterEach(async ({ page }) => {
    if (spaceId) {
      await deleteSpace(page, spaceId);
      spaceId = '';
    }
  });

  // ─── Test: Script gate configuration and save/reopen persistence ─────────

  test('script gate with node interpreter shows badge and configuration persists after save and reopen', async ({
    page,
  }) => {
    await navigateToSpace(page, spaceId);
    const workflowName = await setupWorkflowWithScriptGate(page, SCRIPT_SOURCE);

    // ── Verify badge shows on canvas with script icon ⚡ (pre-save) ───────
    const gateBadge = getFirstGateBadge(page);
    await expect(gateBadge).toBeVisible({ timeout: 5000 });
    await expect(gateBadge).toContainText('\u26A1');

    // ── Save the workflow ─────────────────────────────────────────────────
    const editor = page.getByTestId('visual-workflow-editor');
    await editor.getByTestId('save-button').click();
    // Editor stays open after save; click Back to close it
    editor.getByTestId('back-button').click();
    await expect(page.locator(`text=${workflowName}`)).toBeVisible({ timeout: 5000 });

    // ── Reopen the workflow for editing ────────────────────────────────────
    await openWorkflowForEdit(page, workflowName);

    const reopenedEditor = page.getByTestId('visual-workflow-editor');
    await expect(reopenedEditor).toBeVisible({ timeout: 5000 });

    // ── Verify gate badge still shows script icon ⚡ ──────────────────────
    const reopenedBadge = getFirstGateBadge(page);
    await expect(reopenedBadge).toBeVisible({ timeout: 5000 });
    await expect(reopenedBadge).toContainText('\u26A1');

    // ── Verify gate configuration by opening the gate editor ───────────────
    const regularNodes = () => reopenedEditor.locator('[data-testid^="workflow-node-"]');
    const step1 = regularNodes().first();
    await step1.click();

    const nodePanel = reopenedEditor.getByTestId('node-config-panel');
    await expect(nodePanel).toBeVisible({ timeout: 3000 });

    const channelLinkButton = nodePanel.getByTestId('node-channel-link-button');
    await expect(channelLinkButton).toBeVisible({ timeout: 5000 });
    await channelLinkButton.click();

    const relationPanel = nodePanel.getByTestId('channel-relation-config-panel');
    await expect(relationPanel).toBeVisible({ timeout: 5000 });

    // Click the existing gate to open the editor
    await relationPanel.getByTestId('channel-edge-edit-gate-0').click();

    const gatePanel = nodePanel.getByTestId('gate-editor-panel');
    await expect(gatePanel).toBeVisible({ timeout: 5000 });

    // ── Verify script settings are preserved ──────────────────────────────
    const scriptToggle = gatePanel.getByTestId('gate-editor-script-enabled');
    await expect(scriptToggle).toHaveAttribute('aria-checked', 'true');

    const interpreterSelect = gatePanel.getByTestId('gate-editor-script-interpreter');
    await expect(interpreterSelect).toHaveValue('node');

    const sourceTextarea = gatePanel.getByTestId('gate-editor-script-source');
    const sourceValue = await sourceTextarea.inputValue();
    expect(sourceValue).toBe(SCRIPT_SOURCE);

    // Verify timeout persists (default value)
    const timeoutInput = gatePanel.getByTestId('gate-editor-script-timeout');
    await expect(timeoutInput).toHaveValue(DEFAULT_SCRIPT_TIMEOUT);

    // No gate completeness error
    const gateError = gatePanel.getByTestId('gate-editor-gate-error');
    await expect(gateError).not.toBeVisible({ timeout: 2000 });
  });
});
