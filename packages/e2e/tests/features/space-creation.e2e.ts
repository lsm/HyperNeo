/**
 * Space Creation E2E Tests
 *
 * Verifies:
 * - Navigating to the Spaces section (NavRail Spaces button + New Space button visible)
 * - "Create Space" dialog opens (triggered by "New Space" button)
 * - Workspace path field is required
 * - Name auto-suggests from workspace path
 * - Creating a space navigates to it
 * - Space overview renders with tabbed layout (Active / Review / Done tabs)
 * - Configure page shows all 6 preset agents after creation
 * - Configure page shows all built-in workflows after creation
 *
 * Setup: creates a space via dialog (UI-only)
 * Cleanup: deletes the space via RPC in afterEach (infrastructure)
 */

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
    // Wait for the NavRail to be visible — deterministic signal that the app is ready
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

    // SpacesPage should show "Spaces" heading and "New Space" button
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

    // Dialog should appear
    await expect(getModal(page)).toBeVisible({ timeout: 5000 });
    await expect(page.locator('text=Workspace Path')).toBeVisible({ timeout: 3000 });
  });

  test('workspace path is required — shows error on empty submit', async ({ page }) => {
    const spacesButton = page.getByRole('button', { name: 'Spaces', exact: true });
    await spacesButton.click();
    await page.getByRole('button', { name: 'New Space', exact: true }).click();
    await expect(getModal(page)).toBeVisible({ timeout: 5000 });

    // Submit without filling workspace path
    const submitButton = getModal(page).getByRole('button', { name: 'Create Space' });
    await submitButton.click();

    // Should show validation error
    await expect(page.locator('text=Workspace path is required')).toBeVisible({ timeout: 3000 });
  });

  test('auto-suggests name from workspace path', async ({ page }) => {
    const spacesButton = page.getByRole('button', { name: 'Spaces', exact: true });
    await spacesButton.click();
    await page.getByRole('button', { name: 'New Space', exact: true }).click();
    await expect(getModal(page)).toBeVisible({ timeout: 5000 });

    // Type a workspace path
    const pathInput = page.locator('input[placeholder*="/Users/you/projects"]');
    await pathInput.fill('/projects/my-cool-project');

    // Name should auto-suggest
    const nameInput = page.locator('input[placeholder="e.g., My App"]');
    await expect(nameInput).toHaveValue('my-cool-project', { timeout: 2000 });
  });

  test('creates space and shows tabbed dashboard layout', async ({ page }) => {
    const workspaceRoot = await getWorkspaceRoot(page);
    // Use a unique subdirectory to avoid conflicts with other parallel tests
    // (workspace_path has a UNIQUE constraint in the DB).
    const spaceWorkspacePath = createUniqueSpaceDir(workspaceRoot, 'creation');

    const spacesButton = page.getByRole('button', { name: 'Spaces', exact: true });
    await spacesButton.click();
    await page.getByRole('button', { name: 'New Space', exact: true }).click();
    await expect(getModal(page)).toBeVisible({ timeout: 5000 });

    // Fill workspace path with a unique subdirectory (guaranteed to exist)
    const pathInput = page.locator('input[placeholder*="/Users/you/projects"]');
    await pathInput.fill(spaceWorkspacePath);

    // Set a unique name to avoid conflicts
    const nameInput = page.locator('input[placeholder="e.g., My App"]');
    await nameInput.fill(`E2E Space ${Date.now()}`);

    // Submit
    const submitButton = getModal(page).getByRole('button', { name: 'Create Space' });
    await submitButton.click();

    // Wait for navigation to the new space
    await page.waitForURL(/\/space\/[a-f0-9-]+/, { timeout: 10000 });

    // Extract the space ID from the URL for cleanup
    const url = page.url();
    const match = url.match(/\/space\/([a-f0-9-]+)/);
    if (match) {
      createdSpaceId = match[1];
    }

    // Delete seeded built-in workflows so showCanvas=false and SpaceOverview is
    // visible on desktop viewports (otherwise md:hidden hides it behind WorkflowCanvas).
    if (createdSpaceId) {
      await deleteSpaceWorkflowsViaRpc(page, createdSpaceId);
    }

    // Space overview should be visible after navigation
    await expect(page.getByTestId('space-overview-view')).toBeVisible({ timeout: 5000 });

    // The tabbed layout with Active / Review / Done tabs should render.
    // Tab buttons include a count badge in the accessible name (e.g. "Active 0"),
    // so use substring matching (no exact: true) to match regardless of task count.
    // Scope to space-overview-view to avoid matching the SpaceDetailPanel sidebar tabs
    // (which also contain "Active"/"Review" buttons at the top of the task list).
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

    // Click Cancel
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();

    // Dialog should close
    await expect(getModal(page)).not.toBeVisible({ timeout: 3000 });
  });

  test('configure page shows all 6 preset agents and built-in workflows', async ({ page }) => {
    const workspaceRoot = await getWorkspaceRoot(page);
    const spaceWorkspacePath = createUniqueSpaceDir(workspaceRoot, 'configure');

    // Create space via UI dialog
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

    // Wait for navigation to the new space
    await page.waitForURL(/\/space\/[a-f0-9-]+/, { timeout: 10000 });
    const url = page.url();
    const match = url.match(/\/space\/([a-f0-9-]+)/);
    if (match) {
      createdSpaceId = match[1];
    }

    // Navigate to the configure page
    await page.goto(`/space/${createdSpaceId}/configure`);
    await expect(page.getByTestId('space-configure-tab-bar')).toBeVisible({ timeout: 10000 });

    // Verify all 6 preset agents are visible on the Agents tab (default)
    const PRESET_AGENTS = ['Coder', 'General', 'Planner', 'Research', 'Reviewer', 'QA'];
    for (const agentName of PRESET_AGENTS) {
      await expect(
        page.locator('.text-sm.font-medium.text-gray-100', { hasText: agentName })
      ).toBeVisible({ timeout: 5000 });
    }

    // Navigate to the Workflows tab
    await page.getByTestId('space-configure-tab-workflows').click();

    // Verify all built-in workflows are visible. The five canonical seeded
    // templates: the stable coder-owned Coding and Coding with QA, plus the
    // three non-coding templates. The former merger variants
    // (Coding with Merger, Coding with QA Merger) were removed.
    const BUILT_IN_WORKFLOWS = [
      'Coding',
      'Coding with QA',
      'Research Workflow',
      'Review-Only Workflow',
      'Plan & Decompose Workflow',
    ];
    for (const workflowName of BUILT_IN_WORKFLOWS) {
      await expect(page.locator('text=' + workflowName).first()).toBeVisible({ timeout: 5000 });
    }
  });
});
