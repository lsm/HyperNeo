/**
 * Shared helpers for visual workflow editor E2E tests.
 *
 * Used by:
 * - tests/features/visual-workflow-editor.e2e.ts
 * - tests/features/space-multi-agent-editor.e2e.ts
 */

import type { Page, Locator } from '@playwright/test';
import { expect } from '../../fixtures';
import { waitForWebSocketConnected, getWorkspaceRoot } from './wait-helpers';
import { createUniqueSpaceDir } from './space-helpers';

// ─── Space lifecycle (RPC — infrastructure only) ───────────────────────────────

export async function createSpace(page: Page, name: string): Promise<string> {
  await waitForWebSocketConnected(page);
  const workspaceRoot = await getWorkspaceRoot(page);
  // Use a unique subdirectory to avoid conflicts with other parallel tests
  // (workspace_path has a UNIQUE constraint in the DB).
  const wsPath = createUniqueSpaceDir(workspaceRoot, 'workflow-editor');
  return page.evaluate(
    async ({ wsPath, spaceName }) => {
      const hub = window.__messageHub || window.appState?.messageHub;
      if (!hub?.request) throw new Error('MessageHub not available');

      const res = await hub.request('space.create', { name: spaceName, workspacePath: wsPath });
      return (res as { id: string }).id;
    },
    { wsPath, spaceName: name }
  );
}

export async function deleteSpace(page: Page, spaceId: string): Promise<void> {
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

/** Get the default agent ID for the active space (infrastructure only). */
export async function getDefaultAgentId(page: Page, spaceId: string): Promise<string> {
  return page.evaluate(async (sid) => {
    const hub = window.__messageHub || window.appState?.messageHub;
    if (!hub?.request) throw new Error('Hub not available');
    const res = (await hub.request('spaceAgent.list', { spaceId: sid })) as {
      agents: Array<{ id: string; name: string }>;
    };
    const agent = res.agents.find((a) => a.name === 'Planner') ?? res.agents[0];
    if (!agent) throw new Error('No agents found in space');
    return agent.id;
  }, spaceId);
}

// ─── Navigation helpers ────────────────────────────────────────────────────────

export async function navigateToSpace(page: Page, spaceId: string): Promise<void> {
  await page.goto(`/space/${spaceId}`);
  await page.waitForURL(`/space/${spaceId}**`, { timeout: 10000 });
  // Wait for the overview surface to appear. This confirms space data has loaded.
  await expect(page.getByTestId('space-overview-view')).toBeVisible({ timeout: 15000 });
}

// ─── Editor mode helpers ───────────────────────────────────────────────────────

/**
 * Reset the workflow editor mode stored in localStorage to prevent test-ordering
 * flakiness. SpaceIsland reads 'workflow-editor-mode' on mount; if a prior test
 * left it at 'visual', subsequent tests start in visual mode unexpectedly.
 */
export async function resetEditorModeStorage(page: Page): Promise<void> {
  await page.evaluate(() => {
    localStorage.removeItem('workflow-editor-mode');
  });
}

/**
 * Navigate to Workflows tab and open the workflow editor for a new workflow.
 *
 * The Workflows tab lives inside the Configure page (/space/:id/configure).
 * If the current page is not the configure view, this helper first clicks the
 * "Configure space" gear button in the context panel to get there.
 */
export async function openNewWorkflowEditor(page: Page): Promise<void> {
  // Navigate to configure view if not already there.
  const configureView = page.getByTestId('space-configure-view');
  if (!(await configureView.isVisible().catch(() => false))) {
    await page.getByRole('button', { name: 'Configure space' }).click();
    await expect(configureView).toBeVisible({ timeout: 5000 });
  }

  // Switch to Workflows tab within the configure page.
  await page.getByTestId('space-configure-tab-workflows').click();

  const createBtn = page.getByRole('button', { name: 'Create Workflow' });
  await expect(createBtn).toBeVisible({ timeout: 5000 });
  await createBtn.click();
  // Current UX opens Visual editor directly. Keep compatibility with older
  // builds that still render an editor mode toggle.
  await Promise.any([
    page.getByTestId('visual-workflow-editor').waitFor({ state: 'visible', timeout: 5000 }),
    page.getByTestId('editor-mode-toggle').waitFor({ state: 'visible', timeout: 5000 }),
  ]);
}

/** Switch to Visual editor mode, accepting any confirmation dialogs. */
export async function switchToVisualMode(page: Page): Promise<void> {
  // Modern flow: visual editor is already active.
  if (
    await page
      .getByTestId('visual-workflow-editor')
      .isVisible()
      .catch(() => false)
  ) {
    return;
  }

  // Register dialog handler before clicking — native confirm() fires synchronously
  page.once('dialog', (d) => d.accept());
  await page.getByTestId('editor-mode-visual').click();
  await expect(page.getByTestId('visual-workflow-editor')).toBeVisible({ timeout: 5000 });
}

/**
 * Open the workflow edit UI for an existing workflow in the list.
 * The edit button is CSS group-hover only, so opacity is forced via JS before clicking.
 *
 * The Workflows tab lives inside the Configure page (/space/:id/configure).
 * If the current page is not the configure view, this helper first clicks the
 * "Configure space" gear button in the context panel to get there.
 */
export async function openWorkflowForEdit(page: Page, workflowName: string): Promise<void> {
  // Navigate to configure view if not already there.
  const configureView = page.getByTestId('space-configure-view');
  if (!(await configureView.isVisible().catch(() => false))) {
    await page.getByRole('button', { name: 'Configure space' }).click();
    await expect(configureView).toBeVisible({ timeout: 5000 });
  }

  // Switch to Workflows tab within the configure page.
  await page.getByTestId('space-configure-tab-workflows').click();
  await expect(page.locator(`text=${workflowName}`)).toBeVisible({ timeout: 5000 });

  const workflowCard = page
    .locator('[class*="group"]')
    .filter({ has: page.locator(`text=${workflowName}`) })
    .first();
  await expect(workflowCard).toBeVisible({ timeout: 3000 });
  await workflowCard.evaluate((el) => {
    const actions = el.querySelector<HTMLElement>('[data-testid="workflow-card-actions"]');
    if (actions) actions.style.opacity = '1';
  });

  const editBtn = workflowCard.getByRole('button', { name: 'Edit' });
  await expect(editBtn).toBeVisible({ timeout: 3000 });
  await editBtn.click();

  await Promise.any([
    page.getByTestId('visual-workflow-editor').waitFor({ state: 'visible', timeout: 5000 }),
    page.getByTestId('editor-mode-toggle').waitFor({ state: 'visible', timeout: 5000 }),
  ]);
}

// ─── Multi-agent step helpers ──────────────────────────────────────────────────

/**
 * Configure a node config panel to have two agents in multi-agent mode.
 *
 * Precondition: the NodeConfigPanel is already open (panel locator is visible).
 * Postcondition: agents-list has 2 agent-entry items with the specified agents.
 *
 * @param panel - Locator scoped to the `node-config-panel` element
 * @param agentAOption - Exact option label for the first agent (e.g. "Coder Agent")
 * @param agentBOption - Exact option label for the second agent (e.g. "Reviewer Agent")
 */
export async function setupMultiAgentStep(
  panel: Locator,
  agentAOption: string,
  agentBOption: string
): Promise<void> {
  // Select first agent in single-agent mode
  await panel.getByTestId('agent-select').selectOption({ label: agentAOption });

  // Switch to multi-agent mode — creates 2 agent slots automatically:
  // primary (from current selection) + secondary (auto-picked from remaining agents)
  await panel.getByTestId('add-agent-button').click();
  await expect(panel.getByTestId('agents-list')).toBeVisible({ timeout: 3000 });

  // Verify 2 entries were created by the button click
  const entries = panel.getByTestId('agents-list').getByTestId('agent-entry');
  await expect(entries).toHaveCount(2, { timeout: 3000 });

  // Update the second entry to use the desired agent and role name.
  // The auto-picked secondary may not be the desired agent, so we change both
  // the agent assignment (via agent-slot-select) and the role name (via agent-role-input).
  // Note: fill() must be used (not pressSequentially) because the onInput handler
  // matches agents by their current name in a closure. Character-by-character typing
  // would rename the agent on the first keystroke, making subsequent keystrokes fail
  // to match the original name in the stale closure.
  const secondEntry = entries.nth(1);
  await secondEntry.getByTestId('agent-slot-select').selectOption({ label: agentBOption });
  const roleInput = secondEntry.getByTestId('agent-role-input');
  await roleInput.clear();
  await roleInput.fill(agentBOption);
  // Verify the role name persisted correctly
  await expect(roleInput).toHaveValue(agentBOption, { timeout: 2000 });
}

// ─── Channel helpers (canvas edge-based) ────────────────────────────────────

/**
 * Create a one-way channel by dragging from the output port of one node
 * to the input port of another node on the canvas.
 *
 * Channels are now created via drag-and-drop between node ports, not through
 * a sidebar form. The channel connects two workflow nodes by their step names.
 *
 * @param editor - Locator scoped to the `visual-workflow-editor` element
 * @param fromStepName - Step name of the source node (drag from its output port)
 * @param toStepName - Step name of the target node (drop on its input port)
 */
export async function createChannelByDrag(
  editor: Locator,
  fromStepName: string,
  toStepName: string
): Promise<void> {
  // Find the source node and its output port
  const fromNode = editor.locator(`[data-testid^="workflow-node-"]`).filter({
    hasText: fromStepName,
  });
  const fromPort = fromNode.getByTestId('port-output');
  await expect(fromPort).toBeVisible({ timeout: 3000 });

  // Find the target node and its input port
  const toNode = editor.locator(`[data-testid^="workflow-node-"]`).filter({
    hasText: toStepName,
  });
  const toPort = toNode.getByTestId('port-input');
  await expect(toPort).toBeVisible({ timeout: 3000 });

  // Drag from output port to input port
  await fromPort.dragTo(toPort, { timeout: 10000 });

  // Wait for the channel edge to appear on the canvas.
  // SVG <g> elements can report as "hidden" to Playwright even when rendered,
  // so we wait for the element to be attached and have the expected attributes
  // instead of relying on toBeVisible().
  const channelEdge = editor.locator('[data-channel-edge="true"]').first();
  await channelEdge.waitFor({ state: 'attached', timeout: 5000 });
}

/**
 * Click a channel edge on the canvas to open the channel relation config panel.
 *
 * Channel edge test IDs use internal UUIDs (not step names), so we locate edges
 * by the `data-channel-edge` attribute. When multiple edges exist, pass an
 * explicit index; defaults to the first edge.
 *
 * @param editor - Locator scoped to the `visual-workflow-editor` element
 * @param edgeIndex - Zero-based index of the edge to click (default: 0)
 */
export async function clickChannelEdge(editor: Locator, edgeIndex = 0): Promise<void> {
  const edge = editor.locator('[data-channel-edge="true"]').nth(edgeIndex);
  await edge.waitFor({ state: 'attached', timeout: 5000 });
  // The click handler is on the hitbox <path> (first child) with pointerEvents: 'stroke'.
  // Playwright's click() can miss the thin stroke, so we dispatch a click event directly.
  const hitboxPath = edge.locator('path').first();
  await hitboxPath.dispatchEvent('click');

  // Wait for the channel relation config panel to open
  await expect(editor.getByTestId('channel-relation-config-panel')).toBeVisible({ timeout: 5000 });
}

/**
 * Add a gate to a channel via the channel relation config panel.
 * Precondition: the channel relation config panel must be open (call clickChannelEdge first).
 *
 * @param editor - Locator scoped to the `visual-workflow-editor` element
 */
export async function addGateToChannel(editor: Locator): Promise<void> {
  const panel = editor.getByTestId('channel-relation-config-panel');
  // Click the "Add Gate" button in the channel edge config panel.
  // Assert exactly one button matches to avoid ambiguity when multiple edges exist.
  const addGateBtn = panel.getByTestId(/^channel-edge-add-gate-/);
  await expect(addGateBtn).toHaveCount(1, { timeout: 3000 });
  await addGateBtn.click();
}

/**
 * Close the channel relation config panel.
 *
 * @param editor - Locator scoped to the `visual-workflow-editor` element
 */
export async function closeChannelPanel(editor: Locator): Promise<void> {
  const closeBtn = editor.getByTestId('channel-relation-close-button');
  if (await closeBtn.isVisible().catch(() => false)) {
    await closeBtn.click();
    await expect(editor.getByTestId('channel-relation-config-panel')).not.toBeVisible({
      timeout: 3000,
    });
  }
}
