/**
 * Visual Workflow Editor E2E Tests
 *
 * Tests:
 * - Create workflow with visual editor (add nodes, configure properties, set start node, save)
 * - Node positions are restored after save and reopen (layout persistence)
 * - Load template in visual editor (auto-layout with nodes and edges)
 * - Create workflow opens visual editor directly (list/visual toggle removed)
 * - Validation errors when saving incomplete workflows
 *
 * Setup: creates a Space via RPC in beforeEach (infrastructure).
 * Cleanup: deletes the Space via RPC in afterEach.
 *
 * E2E Rules:
 * - All test actions go through the UI (clicks, inputs, navigation)
 * - All assertions check visible DOM state
 * - RPC is only used in beforeEach/afterEach for test infrastructure
 *
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
  getDefaultAgentId,
} from '../helpers/workflow-editor-helpers';

const DESKTOP_VIEWPORT = { width: 1440, height: 900 };

// ─── RPC helpers (infrastructure only) ────────────────────────────────────────

async function createTestSpace(page: Page): Promise<string> {
  return createSpace(page, `E2E Visual Editor Test ${Date.now()}`);
}

async function deleteTestSpace(page: Page, spaceId: string): Promise<void> {
  return deleteSpace(page, spaceId);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

test.describe('Visual Workflow Editor', () => {
  // All tests share the same workspace path (one space at a time) — must run serially
  test.describe.configure({ mode: 'serial' });
  test.use({ viewport: DESKTOP_VIEWPORT });

  let spaceId = '';

  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    // Clear persisted editor mode so tests are independent of run order
    await resetEditorModeStorage(page);
    spaceId = await createTestSpace(page);
  });

  test.afterEach(async ({ page }) => {
    if (spaceId) {
      await deleteTestSpace(page, spaceId);
      spaceId = '';
    }
  });

  // ─── Test 1: Create workflow with visual editor ──────────────────────────

  // Tracking: https://github.com/lsm/neokai/issues/815 (save issue - editor does not close after clicking save)
  test.skip('Create workflow with visual editor', async ({ page }) => {
    await navigateToSpace(page, spaceId);
    await openNewWorkflowEditor(page);
    await switchToVisualMode(page);

    const editor = page.getByTestId('visual-workflow-editor');

    // Fill workflow name
    await editor.getByTestId('workflow-name-input').fill('Visual Test Workflow');

    // Add 3 nodes via "Add Step" button
    const addStepBtn = editor.getByTestId('add-step-button');
    await addStepBtn.click();
    await addStepBtn.click();
    await addStepBtn.click();

    // 3 nodes should appear on the canvas.
    const nodes = editor.locator('[data-testid^="workflow-node-"]');
    await expect(nodes).toHaveCount(3, { timeout: 3000 });

    // Configure node 1: name + agent.
    // The first added node is auto-designated as start (VisualWorkflowEditor addStep).
    await nodes.nth(0).click();
    await expect(editor.getByTestId('node-config-panel')).toBeVisible({ timeout: 3000 });
    await editor.getByTestId('step-name-input').fill('Planner');
    await editor.getByTestId('agent-select').selectOption({ index: 1 });
    await editor.getByTestId('close-button').click();
    await expect(editor.getByTestId('node-config-panel')).not.toBeVisible({ timeout: 2000 });

    // Verify node 1 shows the start badge after the panel is closed.
    // Assertions on start-badge are intentionally placed after the panel closes — the
    // 320px NodeConfigPanel can visually occlude the badge while open.
    await expect(
      editor
        .locator('[data-testid^="workflow-node-"]')
        .filter({ hasText: 'Planner' })
        .getByTestId('start-badge')
    ).toBeVisible({ timeout: 2000 });

    // Configure node 2: name + agent
    await nodes.nth(1).click();
    await expect(editor.getByTestId('node-config-panel')).toBeVisible({ timeout: 3000 });
    await editor.getByTestId('step-name-input').fill('Coder');
    await editor.getByTestId('agent-select').selectOption({ index: 1 });
    await editor.getByTestId('close-button').click();
    await expect(editor.getByTestId('node-config-panel')).not.toBeVisible({ timeout: 2000 });

    // Configure node 3: name + agent + designate as start
    await nodes.nth(2).click();
    await expect(editor.getByTestId('node-config-panel')).toBeVisible({ timeout: 3000 });
    await editor.getByTestId('step-name-input').fill('Reviewer');
    await editor.getByTestId('agent-select').selectOption({ index: 1 });

    // "Set as Start" only renders when !isStartNode — assert it is visible before clicking
    await expect(editor.getByTestId('set-as-start-button')).toBeVisible({ timeout: 2000 });
    await editor.getByTestId('set-as-start-button').click();

    // Close config panel before asserting badge state on canvas nodes (panel may occlude)
    await editor.getByTestId('close-button').click();
    await expect(editor.getByTestId('node-config-panel')).not.toBeVisible({ timeout: 2000 });

    // Start badge should now appear on the Reviewer node (node 3)
    await expect(
      editor
        .locator('[data-testid^="workflow-node-"]')
        .filter({ hasText: 'Reviewer' })
        .getByTestId('start-badge')
    ).toBeVisible({ timeout: 3000 });

    // Planner node (node 1) should no longer show start badge after reassignment
    await expect(
      editor
        .locator('[data-testid^="workflow-node-"]')
        .filter({ hasText: 'Planner' })
        .getByTestId('start-badge')
    ).not.toBeVisible({ timeout: 2000 });

    // Save the workflow
    await editor.getByTestId('save-button').click();

    // Editor should close after save; workflow should appear in the list
    await expect(page.getByTestId('editor-mode-toggle')).not.toBeVisible({ timeout: 5000 });
    await expect(page.locator('text=Visual Test Workflow')).toBeVisible({ timeout: 5000 });
  });

  // ─── Test 2: Node positions are restored after save and reopen ──────────

  // Tracking: https://github.com/lsm/neokai/issues/815 (save issue - editor does not close after clicking save)
  test.skip('Node positions are restored after save and reopen', async ({ page }) => {
    await navigateToSpace(page, spaceId);

    // Infrastructure: create a workflow with layout positions via RPC
    const agentId = await getDefaultAgentId(page, spaceId);

    await page.evaluate(
      async ({ sid, aId }) => {
        const hub = window.__messageHub || window.appState?.messageHub;
        if (!hub?.request) throw new Error('Hub not available');
        const s1 = crypto.randomUUID();
        const s2 = crypto.randomUUID();
        // Provide layout with deterministic positions
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

    // Navigate to the workflows list
    await page.locator('text=Workflows').first().click();
    await expect(page.locator('text=Layout Persist Test')).toBeVisible({ timeout: 5000 });

    // The Edit button lives inside a data-testid="workflow-card-actions" container that
    // is opacity-0 by default (only visible on CSS group-hover). Force it visible via JS
    // before clicking — Tailwind CSS group-hover is unreliable in headless Chromium/xvfb.
    const workflowCard = page
      .locator('[class*="group"]')
      .filter({ has: page.locator('text=Layout Persist Test') })
      .first();
    await expect(workflowCard).toBeVisible({ timeout: 3000 });
    await workflowCard.evaluate((el) => {
      const actions = el.querySelector<HTMLElement>('[data-testid="workflow-card-actions"]');
      if (actions) actions.style.opacity = '1';
    });

    // Click the Edit button scoped to the target workflow card
    const editBtn = workflowCard.getByRole('button', { name: 'Edit' });
    await expect(editBtn).toBeVisible({ timeout: 3000 });
    await editBtn.click();

    // Wait for editor mode toggle
    await expect(page.getByTestId('editor-mode-toggle')).toBeVisible({ timeout: 5000 });

    // Switch to Visual mode
    await switchToVisualMode(page);

    const editor = page.getByTestId('visual-workflow-editor');

    // Both nodes should appear
    await expect(editor.locator('[data-testid^="workflow-node-"]')).toHaveCount(2, {
      timeout: 5000,
    });

    // Verify step names are rendered
    await expect(editor.locator('text=Step One').first()).toBeVisible({ timeout: 3000 });
    await expect(editor.locator('text=Step Two').first()).toBeVisible({ timeout: 3000 });

    // The start node (Step One) should have the start badge
    const nodeWithStepOne = editor
      .locator('[data-testid^="workflow-node-"]')
      .filter({ has: page.locator('text=Step One') });
    await expect(nodeWithStepOne.getByTestId('start-badge')).toBeVisible({ timeout: 3000 });

    // Verify that the two nodes are at different horizontal positions —
    // the layout positions (x=100 and x=450) should result in nodes being
    // clearly separated on-screen, not stacked at the same location.
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
    // The canvas transforms positions (x=100 vs x=450 → 350px apart in canvas space)
    // After viewport scaling/translation the absolute screen positions differ by >50px
    expect(Math.abs(boxTwo!.x - boxOne!.x)).toBeGreaterThan(50);

    // Save (no changes) and verify round-trip: workflow still in list
    await editor.getByTestId('save-button').click();
    await expect(page.getByTestId('editor-mode-toggle')).not.toBeVisible({ timeout: 5000 });
    await expect(page.locator('text=Layout Persist Test')).toBeVisible({ timeout: 5000 });
  });

  // ─── Test 3: Load template in visual editor ──────────────────────────────

  // Tracking: https://github.com/lsm/neokai/issues/815 (save issue - editor does not close after clicking save)
  test.skip('Load template in visual editor', async ({ page }) => {
    await navigateToSpace(page, spaceId);
    await openNewWorkflowEditor(page);
    await switchToVisualMode(page);

    const editor = page.getByTestId('visual-workflow-editor');

    // Template picker button should be visible on empty new canvas
    await expect(editor.getByTestId('template-picker-button')).toBeVisible({ timeout: 3000 });

    // Open the template dropdown
    await editor.getByTestId('template-picker-button').click();

    // Template options should appear
    await expect(editor.locator('[data-testid="template-option"]').first()).toBeVisible({
      timeout: 3000,
    });

    // Select the Coding template by its exact data-template-label attribute
    // (more precise than partial text match — avoids false matches if new templates added)
    const codingTemplate = editor.locator('[data-template-label="Coding (Plan → Code)"]');
    await expect(codingTemplate).toBeVisible({ timeout: 3000 });
    await codingTemplate.click();

    // Coding template creates 2 nodes (Planner + Coder) with auto-layout.
    const nodes = editor.locator('[data-testid^="workflow-node-"]');
    await expect(nodes).toHaveCount(2, { timeout: 5000 });

    // Verify node names from template
    await expect(editor.locator('text=Planner').first()).toBeVisible({ timeout: 3000 });
    await expect(editor.locator('text=Coder').first()).toBeVisible({ timeout: 3000 });

    // Template picker should be hidden after nodes exist
    await expect(editor.getByTestId('template-picker-button')).not.toBeVisible({
      timeout: 2000,
    });

    // Workflow name should be populated from template
    const nameValue = await editor.getByTestId('workflow-name-input').inputValue();
    expect(nameValue.length).toBeGreaterThan(0);

    // Assign agents to each node before saving
    // Node 1 agent
    await nodes.nth(0).click();
    await expect(editor.getByTestId('node-config-panel')).toBeVisible({ timeout: 3000 });
    await editor.getByTestId('agent-select').selectOption({ index: 1 });
    await editor.getByTestId('close-button').click();

    // Node 2 agent
    await nodes.nth(1).click();
    await expect(editor.getByTestId('node-config-panel')).toBeVisible({ timeout: 3000 });
    await editor.getByTestId('agent-select').selectOption({ index: 1 });
    await editor.getByTestId('close-button').click();

    // Save the workflow
    await editor.getByTestId('save-button').click();

    // Editor should close after save
    await expect(page.getByTestId('editor-mode-toggle')).not.toBeVisible({ timeout: 5000 });
  });

  // ─── Test 4: Create workflow opens visual editor directly ───────────────
  //
  // The list/visual mode toggle was removed in favour of always using the
  // visual editor as the sole editing mode. This test verifies the current
  // UX: clicking "Create Workflow" opens the visual editor immediately with
  // no intermediate mode-selection step.

  test('Create workflow opens visual editor directly', async ({ page }) => {
    await navigateToSpace(page, spaceId);

    // Navigate to Configure → Workflows
    await page.getByRole('button', { name: 'Configure space' }).click();
    await page.getByTestId('space-configure-tab-workflows').click();

    // The "Create Workflow" button must be visible
    const createBtn = page.getByRole('button', { name: 'Create Workflow' });
    await expect(createBtn).toBeVisible({ timeout: 5000 });

    // Click to open the editor
    await createBtn.click();

    // The visual editor must open immediately — no mode-toggle required
    const editor = page.getByTestId('visual-workflow-editor');
    await expect(editor).toBeVisible({ timeout: 5000 });

    // Sanity: the old mode-toggle buttons must NOT be in the DOM (feature removed)
    await expect(page.getByTestId('editor-mode-toggle')).not.toBeAttached();

    // The editor must expose the core controls on an empty canvas
    await expect(editor.getByTestId('workflow-name-input')).toBeVisible({ timeout: 3000 });
    await expect(editor.getByTestId('add-step-button')).toBeVisible({ timeout: 3000 });
  });

  // ─── Test 5: Visual editor validation — missing name ────────────────────

  test('Visual editor shows error when saving without name', async ({ page }) => {
    await navigateToSpace(page, spaceId);
    await openNewWorkflowEditor(page);
    await switchToVisualMode(page);

    const editor = page.getByTestId('visual-workflow-editor');

    // Add a step (so validation reaches the name check)
    await editor.getByTestId('add-step-button').click();
    await expect(editor.locator('[data-testid^="workflow-node-"]')).toHaveCount(1, {
      timeout: 3000,
    });

    // Attempt to save without filling in the name
    await editor.getByTestId('save-button').click();

    // Error banner should appear
    await expect(page.locator('text=Workflow name is required')).toBeVisible({ timeout: 3000 });

    // Editor should remain open
    await expect(editor).toBeVisible();
  });

  // ─── Test 6: Visual editor validation — missing agent ───────────────────

  test('Visual editor shows error when saving without agent assigned', async ({ page }) => {
    await navigateToSpace(page, spaceId);
    await openNewWorkflowEditor(page);
    await switchToVisualMode(page);

    const editor = page.getByTestId('visual-workflow-editor');

    // Fill workflow name
    await editor.getByTestId('workflow-name-input').fill('Test Validation Workflow');

    // Add a step but do not assign an agent
    await editor.getByTestId('add-step-button').click();
    await expect(editor.locator('[data-testid^="workflow-node-"]')).toHaveCount(1, {
      timeout: 3000,
    });

    // Attempt to save
    await editor.getByTestId('save-button').click();

    // Error should mention agent requirement
    await expect(page.locator('text=requires an agent')).toBeVisible({ timeout: 3000 });

    // Editor should remain open
    await expect(editor).toBeVisible();
  });

  // ─── Channel Direction Visualization Tests ──────────────────────────────────
  // These tests verify that channel direction is visually rendered on the canvas.
  // They require:
  // - ChannelEdgeRenderer in WorkflowCanvas.tsx to render arrowhead markers based on direction
  // - ChannelEdge interface to include direction property
  // - Bidirectional channels: double-headed arrow (↔) via marker-start + marker-end
  // - Unidirectional channels: single arrowhead (→) via marker-end only
  // - Channel edges use dashed gray stroke; transition edges use solid colored stroke
  //
  // The arrowhead rendering is part of Change 6 (Show Channel Direction in the Visual
  // Editor) of the workflow graph model goal. Once implemented, remove test.skip().

  // ─── Test 12: Channel edges are visually distinct from transition edges ─────

  // Tracking: https://github.com/lsm/neokai/issues/816 (JS error: hub.request is not a function in page.evaluate)
  // The test uses page.evaluate with hub.request but the hub may not be initialized at that point.
  test.skip('Channel edges are visually distinct from transition edges', async ({ page }) => {
    await navigateToSpace(page, spaceId);

    // Create a workflow with a transition (edge) via RPC so we have both types.
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

    // Navigate to workflows and open in visual mode
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

    // Transition edge should exist and have data attributes
    const transitionEdge = editor.locator(`[data-testid="edge-${t1}"]`);
    await expect(transitionEdge).toBeVisible({ timeout: 5000 });
    await expect(transitionEdge).toHaveAttribute('data-edge-id', t1);

    // Transition edges have solid stroke (not dashed) and colored stroke
    // They use SVG markers for arrowheads
    const transitionPath = transitionEdge.locator('path').first();
    const strokeDasharray = await transitionPath.getAttribute('stroke-dasharray');
    // Transition edges should NOT be dashed (stroke-dasharray should be null or empty)
    expect(strokeDasharray === null || strokeDasharray === '').toBe(true);

    // Channel edges should exist because the workflow includes a channel.
    // They have data-channel-edge="true" attribute.
    const channelEdge = editor.locator('[data-channel-edge="true"]');
    await expect(channelEdge).toBeVisible({ timeout: 5000 });

    // Channel edges should have dashed stroke
    const channelPath = channelEdge.locator('path').last();
    const channelStrokeDasharray = await channelPath.getAttribute('stroke-dasharray');
    // Channel edges ARE dashed (e.g., "6 4")
    expect(channelStrokeDasharray).toMatch(/^\d+\s+\d+$/);
  });

  // ─── Test 14: Bidirectional channels show double-arrowhead edges ────────────

  test.skip('Bidirectional channels show double-arrowhead edges on canvas', async ({ page }) => {
    await navigateToSpace(page, spaceId);
    await openNewWorkflowEditor(page);
    await switchToVisualMode(page);

    const editor = page.getByTestId('visual-workflow-editor');

    // Add a node
    await editor.getByTestId('add-step-button').click();
    await expect(editor.locator('[data-testid^="workflow-node-"]')).toHaveCount(1, {
      timeout: 3000,
    });

    // Select the node and configure it with an agent
    const node = editor.locator('[data-testid^="workflow-node-"]').nth(0);
    await node.click();
    await expect(editor.getByTestId('node-config-panel')).toBeVisible({ timeout: 3000 });
    await editor.getByTestId('agent-select').selectOption({ index: 1 });
    await editor.getByTestId('close-button').click();

    // The ChannelTopologyBadge on the node should show ↔ for bidirectional
    await expect(node.locator('text=↔')).toBeVisible({ timeout: 2000 });

    // The channel edge on canvas should have both marker-start and marker-end
    // (double-headed arrow for bidirectional)
    const channelEdge = editor.locator('[data-channel-edge="true"]');
    await expect(channelEdge).toBeVisible({ timeout: 3000 });

    // Get the visible path element (not the transparent hitbox)
    const channelPath = channelEdge.locator('path:not([stroke="transparent"])');
    await expect(channelPath).toBeVisible({ timeout: 2000 });

    // Bidirectional channels should have both marker-start and marker-end
    const markerEnd = await channelPath.getAttribute('marker-end');
    const markerStart = await channelPath.getAttribute('marker-start');
    expect(markerEnd).not.toBeNull();
    expect(markerStart).not.toBeNull();
    // Both should reference arrow markers
    expect(markerEnd).toMatch(/url\(#.*arrow.*\)/i);
    expect(markerStart).toMatch(/url\(#.*arrow.*\)/i);
  });

  // ─── Test 15: One-way channels show single-arrowhead edges ─────────────────

  test.skip('One-way channels show single-arrowhead edges on canvas', async ({ page }) => {
    await navigateToSpace(page, spaceId);
    await openNewWorkflowEditor(page);
    await switchToVisualMode(page);

    const editor = page.getByTestId('visual-workflow-editor');

    // Add a node and configure it with an agent
    await editor.getByTestId('add-step-button').click();
    await expect(editor.locator('[data-testid^="workflow-node-"]')).toHaveCount(1, {
      timeout: 3000,
    });

    const node = editor.locator('[data-testid^="workflow-node-"]').nth(0);
    await node.click();
    await expect(editor.getByTestId('node-config-panel')).toBeVisible({ timeout: 3000 });
    await editor.getByTestId('agent-select').selectOption({ index: 1 });

    // Open channels section and add a one-way channel
    // First scroll to channels section or open it if collapsed
    const panel = editor.getByTestId('node-config-panel');

    // Look for the channels section toggle or add-channel-form
    const channelsSection = panel.getByTestId('add-channel-form');
    await expect(channelsSection).toBeVisible({ timeout: 2000 });

    // Set direction to one-way (already default)
    await panel.locator('[data-testid="channel-from-select"]').selectOption({ label: 'Planner' });
    await panel
      .locator('[data-testid="channel-to-input"], [data-testid="channel-to-select"]')
      .fill('coder');

    // Click add channel button
    await panel.getByTestId('add-channel-button').click();

    // Verify the channel was added as one-way (→ not ↔)
    const channelEntry = panel
      .locator('[data-testid="channel-entry"]')
      .filter({ has: page.locator('text=→') });
    await expect(channelEntry).toBeVisible({ timeout: 2000 });

    await editor.getByTestId('close-button').click();

    // The channel edge on canvas should have only marker-end (single arrowhead)
    const channelEdge = editor.locator('[data-channel-edge="true"]');
    await expect(channelEdge).toBeVisible({ timeout: 3000 });

    const channelPath = channelEdge.locator('path:not([stroke="transparent"])');
    await expect(channelPath).toBeVisible({ timeout: 2000 });

    // One-way channels should have marker-end but NOT marker-start
    const markerEnd = await channelPath.getAttribute('marker-end');
    const markerStart = await channelPath.getAttribute('marker-start');
    expect(markerEnd).not.toBeNull();
    expect(markerEnd).toMatch(/url\(#.*arrow.*\)/i);
    // marker-start should be null or empty for one-way
    expect(markerStart === null || markerStart === '').toBe(true);
  });

  // ─── Test 16: Channel direction changes are reflected immediately ───────────

  test.skip('Channel direction changes are reflected immediately in canvas', async ({ page }) => {
    await navigateToSpace(page, spaceId);
    await openNewWorkflowEditor(page);
    await switchToVisualMode(page);

    const editor = page.getByTestId('visual-workflow-editor');

    // Add a node and configure it
    await editor.getByTestId('add-step-button').click();
    await expect(editor.locator('[data-testid^="workflow-node-"]')).toHaveCount(1, {
      timeout: 3000,
    });

    const node = editor.locator('[data-testid^="workflow-node-"]').nth(0);
    await node.click();
    await expect(editor.getByTestId('node-config-panel')).toBeVisible({ timeout: 3000 });
    await editor.getByTestId('agent-select').selectOption({ index: 1 });

    const panel = editor.getByTestId('node-config-panel');

    // Add a channel as one-way first
    const channelsSection = panel.getByTestId('add-channel-form');
    await expect(channelsSection).toBeVisible({ timeout: 2000 });
    await panel.locator('[data-testid="channel-from-select"]').selectOption({ label: 'Planner' });
    await panel
      .locator('[data-testid="channel-to-input"], [data-testid="channel-to-select"]')
      .fill('coder');
    await panel.getByTestId('add-channel-button').click();

    // Verify it's one-way on canvas (only marker-end)
    const channelPath1 = editor
      .locator('[data-channel-edge="true"]')
      .locator('path:not([stroke="transparent"])');
    await expect(channelPath1).toBeVisible({ timeout: 2000 });
    const markerEnd1 = await channelPath1.getAttribute('marker-end');
    const markerStart1 = await channelPath1.getAttribute('marker-start');
    expect(markerEnd1).not.toBeNull();
    expect(markerStart1 === null || markerStart1 === '').toBe(true);

    // Now change the channel to bidirectional via the config panel
    // Find the channel entry and change its direction dropdown
    const channelEntry = panel.locator('[data-testid="channel-entry"]').first();
    await expect(channelEntry).toBeVisible({ timeout: 2000 });

    // Look for a direction select within the channel entry
    const directionSelect = channelEntry.locator('select').first();
    if (await directionSelect.isVisible()) {
      await directionSelect.selectOption('bidirectional');
    } else {
      // If no select, look for an edit button or use the add form
      // For now, remove and re-add as bidirectional
      await channelEntry.locator('[data-testid="remove-channel-button"]').click();
      await panel.locator('[data-testid="channel-direction-select"]').selectOption('bidirectional');
      await panel.getByTestId('add-channel-button').click();
    }

    // Wait for the canvas to update: marker-start should become non-null
    // once bidirectional arrowhead rendering is implemented
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

    // Verify the canvas now shows double-arrowhead (both marker-start and marker-end)
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
