import { test, expect } from '../../fixtures';
import { waitForWebSocketConnected, getWorkspaceRoot, getModal } from '../helpers/wait-helpers';
import {
  createUniqueSpaceDir,
  deleteSpaceViaRpc,
  deleteSpaceWorkflowsViaRpc,
} from '../helpers/space-helpers';

const DESKTOP_VIEWPORT = { width: 1280, height: 720 };

test.describe('Space Creation UX', () => {
  test.use({ viewport: DESKTOP_VIEWPORT });

  let createdSpaceId = '';

  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForWebSocketConnected(page);
    await expect(page.getByRole('button', { name: 'Spaces', exact: true })).toBeVisible({
      timeout: 5000,
    });
  });

  test.afterEach(async ({ page }) => {
    if (createdSpaceId) {
      await deleteSpaceViaRpc(page, createdSpaceId);
      createdSpaceId = '';
    }
  });

  test('navigates to Spaces section via NavRail', async ({ page }) => {
    const spacesButton = page.getByRole('button', { name: 'Spaces', exact: true });
    await expect(spacesButton).toBeVisible({ timeout: 5000 });
    await spacesButton.click();

    await expect(page.getByRole('heading', { name: 'Spaces', exact: true })).toBeVisible({
      timeout: 5000,
    });
    await expect(page.getByRole('button', { name: 'New Space', exact: true })).toBeVisible({
      timeout: 5000,
    });
  });

  test('opens Create Space dialog when button clicked', async ({ page }) => {
    const spacesButton = page.getByRole('button', { name: 'Spaces', exact: true });
    await spacesButton.click();

    const createButton = page.getByRole('button', { name: 'New Space', exact: true });
    await expect(createButton).toBeVisible({ timeout: 5000 });
    await createButton.click();

    await expect(getModal(page)).toBeVisible({ timeout: 5000 });
    await expect(page.locator('text=Workspace Path')).toBeVisible({ timeout: 3000 });
  });

  test('workspace path is required — shows error on empty submit', async ({ page }) => {
    const spacesButton = page.getByRole('button', { name: 'Spaces', exact: true });
    await spacesButton.click();
    await page.getByRole('button', { name: 'New Space', exact: true }).click();
    await expect(getModal(page)).toBeVisible({ timeout: 5000 });

    const submitButton = getModal(page).getByRole('button', { name: 'Create Space' });
    await submitButton.click();

    await expect(page.locator('text=Workspace path is required')).toBeVisible({ timeout: 3000 });
  });

  test('auto-suggests name from workspace path', async ({ page }) => {
    const spacesButton = page.getByRole('button', { name: 'Spaces', exact: true });
    await spacesButton.click();
    await page.getByRole('button', { name: 'New Space', exact: true }).click();
    await expect(getModal(page)).toBeVisible({ timeout: 5000 });

    const pathInput = page.locator('input[placeholder*="/Users/you/projects"]');
    await pathInput.fill('/projects/my-cool-project');

    const nameInput = page.locator('input[placeholder="e.g., My App"]');
    await expect(nameInput).toHaveValue('my-cool-project', { timeout: 2000 });
  });

  test('creates space and shows tabbed dashboard layout', async ({ page }) => {
    const workspaceRoot = await getWorkspaceRoot(page);
    const spaceWorkspacePath = createUniqueSpaceDir(workspaceRoot, 'creation');

    const spacesButton = page.getByRole('button', { name: 'Spaces', exact: true });
    await spacesButton.click();
    await page.getByRole('button', { name: 'New Space', exact: true }).click();
    await expect(getModal(page)).toBeVisible({ timeout: 5000 });

    const pathInput = page.locator('input[placeholder*="/Users/you/projects"]');
    await pathInput.fill(spaceWorkspacePath);

    const nameInput = page.locator('input[placeholder="e.g., My App"]');
    await nameInput.fill(`E2E Space ${Date.now()}`);

    const submitButton = getModal(page).getByRole('button', { name: 'Create Space' });
    await submitButton.click();

    await page.waitForURL(/\/space\/[a-f0-9-]+/, { timeout: 10000 });

    const url = page.url();
    const match = url.match(/\/space\/([a-f0-9-]+)/);
    if (match) {
      createdSpaceId = match[1];
    }

    if (createdSpaceId) {
      await deleteSpaceWorkflowsViaRpc(page, createdSpaceId);
    }

    await expect(page.getByTestId('space-overview-view')).toBeVisible({ timeout: 5000 });

    const overviewView = page.getByTestId('space-overview-view');
    await expect(overviewView.getByRole('button', { name: 'Active' })).toBeVisible({
      timeout: 5000,
    });
    await expect(overviewView.getByRole('button', { name: 'Review' })).toBeVisible({
      timeout: 5000,
    });
    await expect(overviewView.getByRole('button', { name: 'Done' })).toBeVisible({
      timeout: 5000,
    });
  });

  test('dialog can be closed with Cancel button', async ({ page }) => {
    const spacesButton = page.getByRole('button', { name: 'Spaces', exact: true });
    await spacesButton.click();
    await page.getByRole('button', { name: 'New Space', exact: true }).click();
    await expect(getModal(page)).toBeVisible({ timeout: 5000 });

    await page.getByRole('button', { name: 'Cancel', exact: true }).click();

    await expect(getModal(page)).not.toBeVisible({ timeout: 3000 });
  });

  test('configure page shows all 6 preset agents and built-in workflows', async ({ page }) => {
    const workspaceRoot = await getWorkspaceRoot(page);
    const spaceWorkspacePath = createUniqueSpaceDir(workspaceRoot, 'configure');

    const spacesButton = page.getByRole('button', { name: 'Spaces', exact: true });
    await spacesButton.click();
    await page.getByRole('button', { name: 'New Space', exact: true }).click();
    await expect(getModal(page)).toBeVisible({ timeout: 5000 });

    const pathInput = page.locator('input[placeholder*="/Users/you/projects"]');
    await pathInput.fill(spaceWorkspacePath);
    const nameInput = page.locator('input[placeholder="e.g., My App"]');
    await nameInput.fill(`E2E Configure ${Date.now()}`);

    const submitButton = getModal(page).getByRole('button', { name: 'Create Space' });
    await submitButton.click();

    await page.waitForURL(/\/space\/[a-f0-9-]+/, { timeout: 10000 });
    const url = page.url();
    const match = url.match(/\/space\/([a-f0-9-]+)/);
    if (match) {
      createdSpaceId = match[1];
    }

    await page.goto(`/space/${createdSpaceId}/configure`);
    await expect(page.getByTestId('space-configure-tab-bar')).toBeVisible({ timeout: 10000 });

    const PRESET_AGENTS = ['Coder', 'General', 'Planner', 'Research', 'Reviewer', 'QA'];
    for (const agentName of PRESET_AGENTS) {
      await expect(
        page.locator('.text-sm.font-medium.text-gray-100', { hasText: agentName })
      ).toBeVisible({ timeout: 5000 });
    }

    await page.getByTestId('space-configure-tab-workflows').click();

    const BUILT_IN_WORKFLOWS = [
      'Coding',
      'Coding with QA',
      'Research Workflow',
      'Review-Only Workflow',
    ];
    for (const workflowName of BUILT_IN_WORKFLOWS) {
      await expect(page.locator('text=' + workflowName).first()).toBeVisible({ timeout: 5000 });
    }
  });
});
