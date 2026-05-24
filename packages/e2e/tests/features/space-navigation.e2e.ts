/**
 * Comprehensive Space Navigation E2E Tests
 *
 * Exercises navigation paths that are NOT fully covered by the narrower test files:
 * - Space Agent: click "Space Agent" in SpaceDetailPanel → ChatContainer renders + active state
 * - Overview tab cycling: SpaceOverview Active/Review/Done tabs are clickable
 * - Deep link: direct /space/:id/agent loads space with agent chat
 *
 * Also provides integration-level coverage for the two-layer nav flow as a single chain:
 * - Level 1→2: NavRail → SpacesPage → click space card → SpaceDetailPanel
 * - Task drill-down: task in SpaceOverview → click → full-width pane → back → dashboard returns
 * - Level 2→1: back button → SpacesPage content (full-width, no sidebar)
 *
 * Note: Space Agent and Dashboard use `data-testid="space-detail-agent"` /
 * `data-testid="space-detail-dashboard"` selectors to disambiguate the sidebar
 * pinned buttons from the SpaceOverview tab-bar buttons, which have identical
 * accessible names ("Active", "Review", etc.) but live in different DOM regions.
 *
 * Overview signal: `[data-testid="space-overview-view"]` is mounted in SpaceIsland
 * when the space dashboard is active; it is absent in agent/task/session views.
 *
 * Setup: creates a space + task via RPC in beforeEach (infrastructure)
 * Cleanup: deletes the space via RPC in afterEach (infrastructure)
 */

import { test, expect } from '../../fixtures';
import { waitForWebSocketConnected, getWorkspaceRoot } from '../helpers/wait-helpers';
import {
  createSpaceViaRpc,
  createUniqueSpaceDir,
  createSpaceTaskViaRpc,
  deleteSpaceViaRpc,
  deleteSpaceWorkflowsViaRpc,
} from '../helpers/space-helpers';

const DESKTOP_VIEWPORT = { width: 1280, height: 720 };

// Overview signal: visible exactly when SpaceOverview is the active view.
// Absent when ChatContainer (agent/session) or SpaceTaskPane is shown instead.
const OVERVIEW_VIEW = '[data-testid="space-overview-view"]';

test.describe('Comprehensive Space Navigation', () => {
  test.use({ viewport: DESKTOP_VIEWPORT });

  let spaceId = '';
  let spaceName = '';
  let taskId = '';
  let taskTitle = '';

  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForWebSocketConnected(page);

    const workspaceRoot = await getWorkspaceRoot(page);
    // Use a unique subdirectory to avoid conflicts with other parallel tests
    // (workspace_path has a UNIQUE constraint in the DB).
    const spaceWorkspacePath = createUniqueSpaceDir(workspaceRoot, 'nav');
    spaceName = `E2E SpaceNav ${Date.now()}`;
    spaceId = await createSpaceViaRpc(page, spaceWorkspacePath, spaceName);
    // Delete seeded built-in workflows so showCanvas=false and SpaceOverview is
    // visible on desktop viewports (otherwise md:hidden hides it behind WorkflowCanvas).
    await deleteSpaceWorkflowsViaRpc(page, spaceId);
    taskTitle = `Nav Task ${Date.now()}`;
    taskId = await createSpaceTaskViaRpc(page, spaceId, taskTitle);
  });

  test.afterEach(async ({ page }) => {
    if (spaceId) {
      await deleteSpaceViaRpc(page, spaceId);
      spaceId = '';
      taskId = '';
    }
    spaceName = '';
    taskTitle = '';
  });

  // ---------------------------------------------------------------------------
  // Level 1 → Level 2 transition (integration chain)
  // ---------------------------------------------------------------------------

  test('Level 1→2: NavRail Spaces → SpacesPage → click space card → SpaceDetailPanel', async ({
    page,
  }) => {
    // Navigate to Spaces via NavRail
    await page.getByRole('button', { name: 'Spaces', exact: true }).click();

    // SpacesPage header: "New Space" button and heading visible
    // Use .first() because the page now renders two "New Space" buttons:
    // the header button and the dashed empty-state card.
    await expect(page.getByRole('button', { name: 'New Space', exact: true }).first()).toBeVisible({
      timeout: 5000,
    });
    await expect(page.getByRole('heading', { name: 'Spaces', exact: true })).toBeVisible({
      timeout: 5000,
    });

    // Back button should NOT be visible at Level 1
    await expect(page.getByTitle('Back to Spaces')).not.toBeVisible();

    // Click the space card to drill into Level 2.
    // SpacesPage renders each space as a card button — clicking anywhere on it navigates.
    await page.getByText(spaceName, { exact: true }).first().click();

    // SpaceDetailPanel: pinned sidebar items visible
    await expect(page.locator('[data-testid="space-detail-dashboard"]')).toBeVisible({
      timeout: 10000,
    });
    await expect(page.locator('[data-testid="space-detail-agent"]')).toBeVisible({ timeout: 5000 });

    // Back button present and space name in header
    await expect(page.getByTitle('Back to Spaces')).toBeVisible({ timeout: 5000 });
    await expect(page.getByRole('heading', { name: spaceName }).first()).toBeVisible({
      timeout: 5000,
    });
  });

  // ---------------------------------------------------------------------------
  // Space Agent navigation + active state
  // ---------------------------------------------------------------------------

  test('Space Agent: click → ChatContainer renders → sidebar item is active', async ({ page }) => {
    await page.goto(`/space/${spaceId}`);
    await page.waitForURL(`/space/${spaceId}`, { timeout: 10000 });

    // SpaceOverview overview visible by default
    await expect(page.locator(OVERVIEW_VIEW)).toBeVisible({ timeout: 5000 });

    // Click "Space Agent" via the sidebar data-testid (avoids name ambiguity)
    await page.locator('[data-testid="space-detail-agent"]').click();

    // URL updates to agent sub-route
    await page.waitForURL(`/space/${spaceId}/agent`, { timeout: 10000 });

    // ChatContainer rendered — message textarea is the canonical signal
    const messageInput = page.locator('textarea[placeholder*="Ask"]').first();
    await expect(messageInput).toBeVisible({ timeout: 10000 });

    // Overview (SpaceOverview) no longer visible — element is unmounted, not just hidden
    await expect(page.locator(OVERVIEW_VIEW)).not.toBeAttached();

    // Sidebar "Space Agent" item should report active state via data-active attribute
    await expect(page.locator('[data-testid="space-detail-agent"]')).toHaveAttribute(
      'data-active',
      'true'
    );
  });

  // ---------------------------------------------------------------------------
  // Overview: click returns to dashboard + Active/Review/Done tabs clickable
  // ---------------------------------------------------------------------------

  test('Overview: click → SpaceOverview returns → Active/Review/Done tabs clickable', async ({
    page,
  }) => {
    // Start in agent view so clicking Overview exercises the navigation
    await page.goto(`/space/${spaceId}/agent`);
    await page.waitForURL(`/space/${spaceId}/agent`, { timeout: 10000 });

    // Confirm overview is gone (ChatContainer is shown instead)
    await expect(page.locator(OVERVIEW_VIEW)).not.toBeAttached({ timeout: 5000 });

    // Click the Overview pinned item via data-testid ("space-detail-dashboard")
    await page.locator('[data-testid="space-detail-dashboard"]').click();

    // URL returns to base space route
    await page.waitForURL(`/space/${spaceId}`, { timeout: 10000 });

    // SpaceOverview overview is visible again
    await expect(page.locator(OVERVIEW_VIEW)).toBeVisible({ timeout: 5000 });

    // Wait for space data to load — verify space name heading appears in context panel
    // and "Space not found" is not shown in SpaceOverview
    await expect(page.getByRole('heading', { name: spaceName })).toBeVisible({ timeout: 10000 });
    await expect(page.locator(OVERVIEW_VIEW).locator('text="Space not found"')).not.toBeAttached({
      timeout: 10000,
    });

    // All 3 SpaceOverview tab buttons should be visible and clickable.
    // These tabs live inside the space-overview-view and are unique to SpaceOverview.
    // StatCard renders <button><span>{count}</span><span>{label}</span></button>;
    // Playwright computes accessible name as "0 Active" (count + label). Use .test() to
    // match label anywhere in the accessible name rather than anchoring to start.
    const overviewView = page.locator(OVERVIEW_VIEW);
    for (const tabName of ['Active', 'Review', 'Done']) {
      const tab = overviewView.getByRole('button', { name: new RegExp(tabName) });
      await expect(tab).toBeVisible({ timeout: 5000 });
      await tab.click();
      await expect(tab).toBeVisible({ timeout: 2000 });
    }
  });

  // ---------------------------------------------------------------------------
  // Task drill-down (integration chain)
  // ---------------------------------------------------------------------------

  test('Task: click task → full-width pane → back → dashboard returns', async ({ page }) => {
    // Navigate to space dashboard — task was created via RPC in beforeEach (status: open)
    await page.goto(`/space/${spaceId}`);
    await page.waitForURL(`/space/${spaceId}`, { timeout: 10000 });

    // SpaceOverview overview visible with "Active" tab selected by default
    await expect(page.locator(OVERVIEW_VIEW)).toBeVisible({ timeout: 5000 });

    // Task should appear in the "Active" group (open tasks)
    await expect(page.getByText(taskTitle, { exact: true })).toBeVisible({ timeout: 5000 });

    // Click task to open full-width pane
    await page.getByText(taskTitle, { exact: true }).first().click();
    await page.waitForURL(`/space/${spaceId}/task/${taskId}`, { timeout: 5000 });

    // Full-width task pane rendered
    await expect(page.locator('[data-testid="space-task-pane"]')).toBeVisible({ timeout: 3000 });

    // Overview (SpaceOverview) no longer visible — element is unmounted, not just hidden
    await expect(page.locator(OVERVIEW_VIEW)).not.toBeAttached();

    // Back button in task pane returns to dashboard view
    await page.locator('[data-testid="task-back-button"]').click();
    await page.waitForURL(`/space/${spaceId}`, { timeout: 5000 });

    // SpaceOverview overview visible again
    await expect(page.locator(OVERVIEW_VIEW)).toBeVisible({ timeout: 3000 });
    await expect(page.locator('[data-testid="space-task-pane"]')).not.toBeAttached();
  });

  // ---------------------------------------------------------------------------
  // Level 2 → Level 1 back navigation
  // ---------------------------------------------------------------------------

  test('Level 2→1: back button → SpacesPage content', async ({ page }) => {
    await page.goto(`/space/${spaceId}`);
    await page.waitForURL(`/space/${spaceId}`, { timeout: 10000 });

    await expect(page.getByTitle('Back to Spaces')).toBeVisible({ timeout: 10000 });

    // Click back
    await page.getByTitle('Back to Spaces').click();

    // Level 1 restored
    await expect(page.getByRole('button', { name: 'New Space', exact: true }).first()).toBeVisible({
      timeout: 5000,
    });
    await expect(page.getByRole('heading', { name: 'Spaces', exact: true })).toBeVisible({
      timeout: 5000,
    });
    await expect(page.getByTitle('Back to Spaces')).not.toBeVisible();

    // SpacesPage renders the spaces card list (heading "Spaces" is already asserted above)
  });

  // ---------------------------------------------------------------------------
  // Deep link: /space/:id/agent
  // ---------------------------------------------------------------------------

  test('deep link /space/:id/agent → space loads with ChatContainer', async ({ page }) => {
    await page.goto(`/space/${spaceId}/agent`);
    await page.waitForURL(`/space/${spaceId}/agent`, { timeout: 10000 });

    // Wait for WS after hard navigation
    await waitForWebSocketConnected(page);

    // ContextPanel at Level 2 — space name in header
    await expect(page.getByRole('heading', { name: spaceName }).first()).toBeVisible({
      timeout: 10000,
    });

    // SpaceDetailPanel sidebar items visible
    await expect(page.locator('[data-testid="space-detail-agent"]')).toBeVisible({ timeout: 5000 });

    // ChatContainer rendered
    const messageInput = page.locator('textarea[placeholder*="Ask"]').first();
    await expect(messageInput).toBeVisible({ timeout: 10000 });

    // Overview (SpaceOverview) not visible — element is unmounted, not just hidden
    await expect(page.locator(OVERVIEW_VIEW)).not.toBeAttached();
  });
});
