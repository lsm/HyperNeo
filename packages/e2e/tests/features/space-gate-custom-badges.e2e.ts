/**
 * Gate Custom Badges E2E Tests
 *
 * Tests customizable badge label and color on workflow gate badges:
 * - Create a gate on a channel via the visual editor
 * - Verify badge shows "Gate" when no custom label is set
 * - Set a custom label and verify the badge text updates on the canvas
 * - Set a custom color and verify the badge fill updates on the canvas
 * - Remove the custom label and verify it falls back to "Gate"
 * - Create a script-only gate (no fields) and verify the editor works
 *
 * Setup: creates a Space via RPC in beforeEach.
 * Cleanup: deletes the Space via RPC in afterEach.
 *
 * E2E Rules:
 * - All test actions go through the UI (clicks, inputs, navigation)
 * - All assertions check visible DOM state (badge SVG text, fill attributes)
 * - RPC is only used in beforeEach / afterEach for infrastructure setup / teardown
 *
 * UI Flow:
 *   Add 2 steps → port-drag to create channel → Node click → NodeConfigPanel →
 *   channel-link button → ChannelRelationConfigPanel (embedded) → "Add Gate" →
 *   GateEditorPanel (embedded, via onEditGate)
 *   Changes in GateEditorPanel propagate reactively to the canvas EdgeRenderer badge.
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
} from '../helpers/workflow-editor-helpers';

const DESKTOP_VIEWPORT = { width: 1440, height: 900 };

// ─── RPC helpers (infrastructure only) ───────────────────────────────────────

/**
 * Creates a space for gate badge test scenarios.
 */
async function createTestSpace(page: Page): Promise<string> {
  const spaceName = `E2E Gate Badges ${Date.now()}`;
  return createSpace(page, spaceName);
}

// ─── UI action helpers ────────────────────────────────────────────────────────

/**
 * Sets up a workflow with two regular steps connected by a channel.
 *
 * Preconditions:
 *   - Space is created
 *   - Page is navigated to the space
 *
 * Postconditions:
 *   - Visual workflow editor is open with 2 named steps
 *   - A one-way channel exists from step 1 (start) to step 2
 *   - NodeConfigPanel is closed
 */
async function setupWorkflowWithChannel(page: Page): Promise<void> {
  await openNewWorkflowEditor(page);
  await switchToVisualMode(page);

  const editor = page.getByTestId('visual-workflow-editor');
  await editor.getByTestId('workflow-name-input').fill('Gate Badges Test');

  // Add step 1 (auto-designated as start node)
  await editor.getByTestId('add-step-button').click();
  const regularNodes = () => editor.locator('[data-testid^="workflow-node-"]');
  await expect(regularNodes()).toHaveCount(1, { timeout: 3000 });

  // Name step 1
  const step1 = regularNodes().first();
  await step1.click();
  const panel1 = editor.getByTestId('node-config-panel');
  await expect(panel1).toBeVisible({ timeout: 3000 });
  await panel1.getByTestId('step-name-input').fill('Gate Step');
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
  await panel2.getByTestId('step-name-input').fill('Target Step');
  await panel2.getByTestId('close-button').click();
  await expect(panel2).not.toBeVisible({ timeout: 2000 });

  // Create a channel by dragging from step 1's output port to step 2's input port
  const step1Output = step1.getByTestId('port-output');
  const step2Input = step2.getByTestId('port-input');
  await step1Output.dragTo(step2Input);

  // Verify an edge now renders on the canvas between the two nodes
  await expect(editor.locator('[data-testid^="channel-edge-"]')).toHaveCount(1, { timeout: 5000 });

  // Verify the channel was created: step 1 should now show a channel-links entry
  await step1.click();
  const verifyPanel = editor.getByTestId('node-config-panel');
  await expect(verifyPanel).toBeVisible({ timeout: 3000 });
  await expect(verifyPanel.getByTestId('node-channel-link-button')).toBeVisible({ timeout: 5000 });
  await verifyPanel.getByTestId('close-button').click();
  await expect(verifyPanel).not.toBeVisible({ timeout: 2000 });
}

/**
 * Opens the gate editor for the first channel by clicking through:
 *   Node → NodeConfigPanel → channel-link button → "Add Gate"
 *
 * Preconditions:
 *   - Visual workflow editor is open with 2 steps connected by a channel
 *   - NodeConfigPanel is closed
 *
 * Postconditions:
 *   - GateEditorPanel is visible (embedded in NodeConfigPanel)
 *   - A new gate has been created with empty fields
 *   - The gate editor is in edit mode for the newly created gate
 */
async function openGateEditorForChannel(page: Page): Promise<void> {
  const editor = page.getByTestId('visual-workflow-editor');

  // Click step 1 to open NodeConfigPanel
  const regularNodes = () => editor.locator('[data-testid^="workflow-node-"]');
  await regularNodes().first().click();
  const nodePanel = editor.getByTestId('node-config-panel');
  await expect(nodePanel).toBeVisible({ timeout: 3000 });

  // Click the channel-link button to open ChannelRelationConfigPanel (embedded)
  const channelLinkButton = nodePanel.getByTestId('node-channel-link-button');
  await expect(channelLinkButton).toBeVisible({ timeout: 5000 });
  await channelLinkButton.click();

  // ChannelRelationConfigPanel should appear (embedded in NodeConfigPanel)
  const relationPanel = nodePanel.getByTestId('channel-relation-config-panel');
  await expect(relationPanel).toBeVisible({ timeout: 5000 });

  // Click "Add Gate" to create a gate and open GateEditorPanel
  await relationPanel.getByTestId('channel-edge-add-gate-0').click();

  // GateEditorPanel should now be visible (embedded, no header)
  // handleAddGate() calls onEditGate() which switches panelView to 'gate-editor'
  const gatePanel = nodePanel.getByTestId('gate-editor-panel');
  await expect(gatePanel).toBeVisible({ timeout: 5000 });
}

/**
 * Returns a locator for the first gate badge on the canvas SVG.
 * Uses a prefix match since the badge testid includes step IDs (UUIDs).
 */
function getFirstGateBadge(page: Page) {
  return page.locator('[data-testid^="channel-gate-"]').first();
}

// ─── Tests ────────────────────────────────────────────────────────────────────

test.describe('Gate Custom Badges', () => {
  // Serial mode is required because tests share describe-scoped spaceId state
  // via beforeEach/afterEach, and parallel execution causes workspace_path collisions.
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

  // ─── Test 1: Custom label on gate badge ──────────────────────────────────

  test('gate badge shows custom label and color with heuristic fallback', async ({ page }) => {
    await navigateToSpace(page, spaceId);
    await setupWorkflowWithChannel(page);
    await openGateEditorForChannel(page);

    const editor = page.getByTestId('visual-workflow-editor');
    const nodePanel = editor.getByTestId('node-config-panel');
    const gatePanel = nodePanel.getByTestId('gate-editor-panel');

    // ── Step 1: Verify initial badge shows "Gate" ────────────────────────
    // A newly created gate has no custom label, so it falls back to "Gate".
    const gateBadge = getFirstGateBadge(page);
    await expect(gateBadge).toBeVisible({ timeout: 5000 });
    await expect(gateBadge).toContainText('Gate');

    // ── Step 2: Add Approval preset → gate requires external approval ───
    await gatePanel.getByTestId('gate-editor-preset-approval').click();

    // Badge still shows "Gate" (no heuristic fallback - label is authoritative)
    await expect(gateBadge).toContainText('Gate', { timeout: 5000 });

    // ── Step 3: Set custom label "Approve" ───────────────────────────────
    const labelInput = gatePanel.getByTestId('gate-editor-label');
    await labelInput.fill('Approve');

    // Badge on canvas should update to show custom label
    await expect(gateBadge).toContainText('Approve', { timeout: 3000 });

    // Badge preview in GateEditorPanel should also show "Approve"
    const badgePreview = gatePanel.getByTestId('gate-editor-badge-preview');
    await expect(badgePreview).toContainText('Approve');

    // ── Step 4: Set custom color #ff5500 ────────────────────────────────
    // Use evaluate to set the color value and dispatch both input and change events.
    // This ensures the handler fires regardless of whether Preact's onChange maps to
    // the DOM input or change event (behavior varies by Preact version and input type).
    const colorInput = gatePanel.getByTestId('gate-editor-color');
    await colorInput.evaluate((el: HTMLInputElement, val) => {
      el.value = val;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }, '#ff5500');

    // Badge preview should reflect the custom color
    // (canvas badge text uses white fill when edge is selected)
    const previewText = badgePreview.locator('text').first();
    await expect(previewText).toHaveAttribute('fill', '#ff5500', { timeout: 3000 });

    // Color hex display should update next to the picker
    await expect(gatePanel.locator('text=#ff5500')).toBeVisible({ timeout: 2000 });

    // ── Step 5: Remove custom label → verify fallback to "Gate" ─────────
    await labelInput.fill('');

    // Badge falls back to "Gate" (no heuristic fallback)
    await expect(gateBadge).toContainText('Gate', { timeout: 3000 });

    // Badge preview also falls back to "Gate"
    await expect(badgePreview).toContainText('Gate');
  });

  // ─── Test 2: Script-only gate (no fields) ────────────────────────────────

  test('script-only gate can be created and the editor works', async ({ page }) => {
    await navigateToSpace(page, spaceId);
    await setupWorkflowWithChannel(page);
    await openGateEditorForChannel(page);

    const editor = page.getByTestId('visual-workflow-editor');
    const nodePanel = editor.getByTestId('node-config-panel');
    const gatePanel = nodePanel.getByTestId('gate-editor-panel');

    // ── Step 1: Toggle script enabled ────────────────────────────────────
    const scriptToggle = gatePanel.getByTestId('gate-editor-script-enabled');
    await scriptToggle.click();
    await expect(scriptToggle).toHaveAttribute('aria-checked', 'true');

    // ── Step 2: Verify script section UI renders ─────────────────────────
    const interpreterSelect = gatePanel.getByTestId('gate-editor-script-interpreter');
    await expect(interpreterSelect).toBeVisible({ timeout: 3000 });

    const sourceTextarea = gatePanel.getByTestId('gate-editor-script-source');
    await expect(sourceTextarea).toBeVisible({ timeout: 2000 });

    const timeoutInput = gatePanel.getByTestId('gate-editor-script-timeout');
    await expect(timeoutInput).toBeVisible({ timeout: 2000 });

    // Default timeout should be 30
    await expect(timeoutInput).toHaveValue('30');

    // ── Step 3: Set interpreter to "node" ───────────────────────────────
    await interpreterSelect.selectOption({ value: 'node' });

    // ── Step 4: Type script source ───────────────────────────────────────
    await sourceTextarea.fill("console.log('hello from gate script')");

    // ── Step 5: Verify no gate completeness error ────────────────────────
    // With script enabled and source set, the gate should pass completeness validation
    const gateError = gatePanel.getByTestId('gate-editor-gate-error');
    await expect(gateError).not.toBeVisible({ timeout: 2000 });

    // ── Step 6: Verify badge shows on canvas ────────────────────────────
    // Gate has fields:[] + script enabled → badge renders with "Gate" fallback
    const gateBadge = getFirstGateBadge(page);
    await expect(gateBadge).toBeVisible({ timeout: 5000 });

    // Badge shows "Gate" (no heuristic fallback)
    await expect(gateBadge).toContainText('Gate');

    // ── Step 7: Verify script icon ⚡ appears in the badge ──────────
    // The script icon is a separate <text> element containing the lightning bolt
    await expect(gateBadge).toContainText('\u26A1');

    // ── Step 8: Verify Lint Check preset works ──────────────────────────
    await gatePanel.getByTestId('gate-editor-preset-lint').click();

    // Interpreter should be 'bash' and source should contain 'npm run lint'
    await expect(interpreterSelect).toHaveValue('bash');
    const sourceValue = await sourceTextarea.inputValue();
    expect(sourceValue).toContain('npm run lint');

    // ── Step 9: Verify Type Check preset works ──────────────────────────
    await gatePanel.getByTestId('gate-editor-preset-typecheck').click();

    await expect(interpreterSelect).toHaveValue('bash');
    const sourceValue2 = await sourceTextarea.inputValue();
    expect(sourceValue2).toContain('npx tsc --noEmit');
  });
});
