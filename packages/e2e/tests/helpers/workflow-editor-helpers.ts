import type { Page, Locator } from '@playwright/test';
import { expect } from '../../fixtures';
import { waitForWebSocketConnected, getWorkspaceRoot } from './wait-helpers';
import { createUniqueSpaceDir } from './space-helpers';

export async function createSpace(page: Page, name: string): Promise<string> {
  await waitForWebSocketConnected(page);
  const workspaceRoot = await getWorkspaceRoot(page);
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

export async function navigateToSpace(page: Page, spaceId: string): Promise<void> {
  await page.goto(`/space/${spaceId}`);
  await page.waitForURL(`/space/${spaceId}**`, { timeout: 10000 });
  await expect(page.getByTestId('space-overview-view')).toBeVisible({ timeout: 15000 });
}

export async function resetEditorModeStorage(page: Page): Promise<void> {
  await page.evaluate(() => {
    localStorage.removeItem('workflow-editor-mode');
  });
}

export async function openNewWorkflowEditor(page: Page): Promise<void> {
  const configureView = page.getByTestId('space-configure-view');
  if (!(await configureView.isVisible().catch(() => false))) {
    await page.getByRole('button', { name: 'Configure space' }).click();
    await expect(configureView).toBeVisible({ timeout: 5000 });
  }

  await page.getByTestId('space-configure-tab-workflows').click();

  const createBtn = page.getByRole('button', { name: 'Create Workflow' });
  await expect(createBtn).toBeVisible({ timeout: 5000 });
  await createBtn.click();
  await Promise.any([
    page.getByTestId('visual-workflow-editor').waitFor({ state: 'visible', timeout: 5000 }),
    page.getByTestId('editor-mode-toggle').waitFor({ state: 'visible', timeout: 5000 }),
  ]);
}

export async function switchToVisualMode(page: Page): Promise<void> {
  if (
    await page
      .getByTestId('visual-workflow-editor')
      .isVisible()
      .catch(() => false)
  ) {
    return;
  }

  page.once('dialog', (d) => d.accept());
  await page.getByTestId('editor-mode-visual').click();
  await expect(page.getByTestId('visual-workflow-editor')).toBeVisible({ timeout: 5000 });
}

export async function openWorkflowForEdit(page: Page, workflowName: string): Promise<void> {
  const configureView = page.getByTestId('space-configure-view');
  if (!(await configureView.isVisible().catch(() => false))) {
    await page.getByRole('button', { name: 'Configure space' }).click();
    await expect(configureView).toBeVisible({ timeout: 5000 });
  }

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

export async function setupMultiAgentStep(
  panel: Locator,
  agentAOption: string,
  agentBOption: string
): Promise<void> {
  await panel.getByTestId('agent-select').selectOption({ label: agentAOption });

  await panel.getByTestId('add-agent-button').click();
  await expect(panel.getByTestId('agents-list')).toBeVisible({ timeout: 3000 });

  const entries = panel.getByTestId('agents-list').getByTestId('agent-entry');
  await expect(entries).toHaveCount(2, { timeout: 3000 });

  const secondEntry = entries.nth(1);
  await secondEntry.getByTestId('agent-slot-select').selectOption({ label: agentBOption });
  const roleInput = secondEntry.getByTestId('agent-role-input');
  await roleInput.clear();
  await roleInput.fill(agentBOption);
  await expect(roleInput).toHaveValue(agentBOption, { timeout: 2000 });
}

export async function createChannelByDrag(
  editor: Locator,
  fromStepName: string,
  toStepName: string
): Promise<void> {
  const fromNode = editor.locator(`[data-testid^="workflow-node-"]`).filter({
    hasText: fromStepName,
  });
  const fromPort = fromNode.getByTestId('port-output');
  await expect(fromPort).toBeVisible({ timeout: 3000 });

  const toNode = editor.locator(`[data-testid^="workflow-node-"]`).filter({
    hasText: toStepName,
  });
  const toPort = toNode.getByTestId('port-input');
  await expect(toPort).toBeVisible({ timeout: 3000 });

  await fromPort.dragTo(toPort, { timeout: 10000 });

  const channelEdge = editor.locator('[data-channel-edge="true"]').first();
  await channelEdge.waitFor({ state: 'attached', timeout: 5000 });
}

export async function clickChannelEdge(editor: Locator, edgeIndex = 0): Promise<void> {
  const edge = editor.locator('[data-channel-edge="true"]').nth(edgeIndex);
  await edge.waitFor({ state: 'attached', timeout: 5000 });
  const hitboxPath = edge.locator('path').first();
  await hitboxPath.dispatchEvent('click');

  await expect(editor.getByTestId('channel-relation-config-panel')).toBeVisible({ timeout: 5000 });
}

export async function closeChannelPanel(editor: Locator): Promise<void> {
  const closeBtn = editor.getByTestId('channel-relation-close-button');
  if (await closeBtn.isVisible().catch(() => false)) {
    await closeBtn.click();
    await expect(editor.getByTestId('channel-relation-config-panel')).not.toBeVisible({
      timeout: 3000,
    });
  }
}
