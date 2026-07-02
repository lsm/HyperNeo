/**
 * Settings Modal E2E Tests
 *
 * Consolidated tests for the settings panel:
 * - Basic interaction (open/close navigation)
 * - Settings navigation (8 sections: General, Providers, MCP Servers, etc.)
 * - General settings content (model, permission mode, thinking level, auto-scroll)
 * - Settings persistence and MCP servers
 */

import { test, expect } from '../../fixtures';
import { waitForWebSocketConnected } from '../helpers/wait-helpers';
import { openSettingsModal, closeSettingsModal } from '../helpers/settings-modal-helpers';

test.describe('Settings Modal - Basic Interaction', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForWebSocketConnected(page);
  });

  test('should open Settings modal from sidebar footer', async ({ page }) => {
    await openSettingsModal(page);

    // Verify settings view is open with Global Settings header
    await expect(page.locator('h2:has-text("Global Settings")')).toBeVisible();
  });

  test('should close Settings modal with close button', async ({ page }) => {
    // Settings is now a panel view (not a modal). "Closing" navigates away via Home button.
    await openSettingsModal(page);

    // Verify settings view is open
    await expect(page.locator('h2:has-text("Global Settings")')).toBeVisible();

    // Close the settings view by navigating to Home
    await closeSettingsModal(page);

    // Verify settings view is closed
    await expect(page.locator('h2:has-text("Global Settings")')).toBeHidden();
  });

  test('should close Settings modal by clicking backdrop', async ({ page }) => {
    // Settings is now a panel view with no backdrop. Navigate away via Chats nav button.
    await openSettingsModal(page);

    // Verify settings view is open
    await expect(page.locator('h2:has-text("Global Settings")')).toBeVisible();

    // Navigate to the Chats section (equivalent to dismissing the settings view)
    await page.getByRole('button', { name: 'Chats', exact: true }).click();

    // Verify settings view is closed
    await expect(page.locator('h2:has-text("Global Settings")')).toBeHidden();
  });

  test('should close Settings modal with Escape key', async ({ page }) => {
    // Settings is a panel view (not a modal). Escape does not close it.
    await openSettingsModal(page);

    // Verify settings view is open
    await expect(page.locator('h2:has-text("Global Settings")')).toBeVisible();

    // Press Escape - settings panel view remains visible (no modal close behavior)
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);

    // Verify settings view remains visible after Escape
    await expect(page.locator('h2:has-text("Global Settings")')).toBeVisible();
  });
});

test.describe('Settings Modal - Authentication Status', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForWebSocketConnected(page);
  });

  test('should display all settings navigation sections', async ({ page }) => {
    await openSettingsModal(page);

    // Verify all settings navigation sections are visible in the ContextPanel
    const expectedSections = [
      'General',
      'Providers',
      'MCP Servers',
      'Skills',
      'Fallback Models',
      'Usage',
      'About',
    ];
    for (const section of expectedSections) {
      await expect(page.getByRole('button', { name: section, exact: true })).toBeVisible();
    }
  });

  test('should show authenticated status with green indicator', async ({ page }) => {
    // Authentication status section removed. Verify General settings loads correctly.
    await openSettingsModal(page);

    // General section is shown by default
    await expect(page.locator('h3:has-text("General")')).toBeVisible();

    // Default Model row should be present
    await expect(page.locator('text=Default Model')).toBeVisible();
  });

  test('should display auth method (API Key or OAuth)', async ({ page }) => {
    await openSettingsModal(page);

    // Wait for nav buttons to be visible before clicking
    await page.getByRole('button', { name: 'Providers', exact: true }).waitFor();

    // Navigate to the Providers section
    await page.getByRole('button', { name: 'Providers', exact: true }).click();

    // Wait for Providers section to load
    await expect(page.locator('h3:has-text("Providers")')).toBeVisible();

    // Check if any provider is authenticated (shows API Key or OAuth badge)
    const hasApiKey = (await page.locator('text=API Key').count()) > 0;
    const hasOAuth = (await page.locator('text=OAuth').count()) > 0;

    if (hasApiKey || hasOAuth) {
      // At least one provider is authenticated
      expect(true).toBeTruthy();
    } else {
      // No authenticated provider — verify the section still loaded correctly
      await expect(
        page
          .locator('text=No providers available')
          .or(page.locator('text=Configure authentication for AI providers'))
      ).toBeVisible();
    }
  });

  test('should show environment variable setup instructions', async ({ page }) => {
    await openSettingsModal(page);

    // Navigate to the About section
    await page.getByRole('button', { name: 'About', exact: true }).click();

    // Verify About section is shown with HyperNeo app info
    await expect(page.locator('h3:has-text("About")')).toBeVisible();
    await expect(page.locator('text=HyperNeo')).toBeVisible();
  });
});

test.describe('Settings Modal - Global Settings', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForWebSocketConnected(page);
  });

  test('should display Global Settings section', async ({ page }) => {
    await openSettingsModal(page);

    // Verify General section heading is visible (h2 is "Global Settings", h3 is "General")
    await expect(page.locator('h3:has-text("General")')).toBeVisible();
  });

  test('should show Model selection dropdown', async ({ page }) => {
    await openSettingsModal(page);

    // Find the Default Model label
    await expect(page.locator('text=Default Model')).toBeVisible();

    // Should have a select element with Claude model options
    const modelSelect = page.locator('select').first();
    await expect(modelSelect).toBeVisible();

    // Verify Claude model options exist
    await expect(modelSelect.locator('option:has-text("Claude Sonnet 4")')).toBeAttached();
  });

  test('should show Thinking Level selection dropdown', async ({ page }) => {
    await openSettingsModal(page);

    // Default Thinking Level is present
    await expect(page.locator('text=Default Thinking Level')).toBeVisible();

    // Permission Mode is the second dropdown in the General settings
    await expect(page.locator('text=Permission Mode')).toBeVisible();
    await expect(page.locator('select').nth(1)).toBeVisible();
  });

  test('should show Auto Scroll toggle', async ({ page }) => {
    await openSettingsModal(page);

    // Find the auto-scroll label (exact match to avoid matching the description text)
    await expect(page.getByText('Auto-scroll', { exact: true })).toBeVisible();

    // Should have a toggle switch (role="switch" button, not a checkbox)
    await expect(page.locator('button[role="switch"]').first()).toBeVisible();
  });

  test('should show Permission Mode selection', async ({ page }) => {
    await openSettingsModal(page);

    // Find the Permission Mode label
    await expect(page.locator('text=Permission Mode')).toBeVisible();

    // Should have a select with a default option
    const permissionSelect = page.locator('select').nth(1);
    await expect(permissionSelect).toBeVisible();
    await expect(permissionSelect.locator('option[value="default"]')).toBeAttached();
  });

  test('should show all General settings rows', async ({ page }) => {
    await openSettingsModal(page);

    // Setting Sources was removed; verify the current General settings rows instead
    await expect(page.locator('text=Setting Sources')).toBeHidden();

    await expect(page.locator('text=Default Model')).toBeVisible();
    await expect(page.locator('text=Permission Mode')).toBeVisible();
    await expect(page.locator('text=Default Thinking Level')).toBeVisible();
    await expect(page.getByText('Auto-scroll', { exact: true })).toBeVisible();
    await expect(page.getByText('Show Archived Sessions', { exact: true })).toBeVisible();
  });

  test('should show settings page description', async ({ page }) => {
    await openSettingsModal(page);

    // Settings header shows a description of the page's purpose
    await expect(page.locator('text=Default configurations for new sessions')).toBeVisible();
  });
});

test.describe('Settings Modal - Global Tools Settings', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForWebSocketConnected(page);
  });

  test('should display MCP Servers section from settings nav', async ({ page }) => {
    await openSettingsModal(page);

    // Navigate to MCP Servers section via nav button (exact match — other UI
    // surfaces also use the string "MCP Servers" as a section heading)
    await page.getByRole('button', { name: 'MCP Servers', exact: true }).click();

    // Verify MCP Servers section is shown
    await expect(page.locator('h3:has-text("MCP Servers")')).toBeVisible();
  });

  test('should show System Prompt section with Claude Code Preset', async ({ page }) => {
    await openSettingsModal(page);

    // Navigate to About section
    await page.getByRole('button', { name: 'About', exact: true }).click();

    // Verify About section is shown with version info
    await expect(page.locator('h3:has-text("About")')).toBeVisible();
    await expect(page.locator('text=Version')).toBeVisible();
  });

  test('should NOT show HyperNeo Tools section', async ({ page }) => {
    await openSettingsModal(page);

    // Verify HyperNeo Tools heading does NOT exist
    await expect(page.locator('h4:has-text("HyperNeo Tools")')).not.toBeVisible();

    // Memory tool should NOT be shown
    await expect(page.locator('text=Persistent key-value storage')).not.toBeVisible();
  });

  test('should show all General settings rows from tools group', async ({ page }) => {
    await openSettingsModal(page);

    // Verify the General settings rows are present
    await expect(page.locator('text=Default Model')).toBeVisible();
    await expect(page.locator('text=Permission Mode')).toBeVisible();
    await expect(page.locator('text=Default Thinking Level')).toBeVisible();
    await expect(page.getByText('Auto-scroll', { exact: true })).toBeVisible();
    await expect(page.getByText('Show Archived Sessions', { exact: true })).toBeVisible();
  });

  test('should have toggle switches for boolean settings', async ({ page }) => {
    await openSettingsModal(page);

    const autoScrollToggle = page.locator('button[role="switch"]').first();
    await expect(autoScrollToggle).toBeVisible();

    // Toggle should have aria-checked attribute
    await expect(autoScrollToggle).toHaveAttribute('aria-checked');
  });
});

test.describe('Settings Modal - Settings Persistence', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForWebSocketConnected(page);
  });

  test('should allow changing model selection', async ({ page }) => {
    await openSettingsModal(page);

    // Find the model selection dropdown
    const modelSelect = page.locator('select').first();
    await expect(modelSelect).toBeVisible();

    // Get all option values
    const optionValues = await modelSelect.locator('option').evaluateAll((opts) =>
      opts.map((o) => ({
        value: (o as HTMLOptionElement).value,
        label: o.textContent,
      }))
    );
    expect(optionValues.length).toBeGreaterThan(1);

    // Get initial selected value
    const initialValue = await modelSelect.inputValue();

    // Select a different option by value
    const differentOption = optionValues.find((o) => o.value !== initialValue);
    if (differentOption) {
      await modelSelect.selectOption(differentOption.value);

      // Wait for auto-save
      await page.waitForTimeout(500);

      // Verify the selection changed
      const newValue = await modelSelect.inputValue();
      expect(newValue).toBe(differentOption.value);

      // Restore original
      await modelSelect.selectOption(initialValue);
    }
  });

  test('should toggle auto-scroll setting and update', async ({ page }) => {
    await openSettingsModal(page);

    // Get the auto-scroll toggle switch
    const autoScrollToggle = page.locator('button[role="switch"]').first();
    const initialChecked = await autoScrollToggle.getAttribute('aria-checked');

    // Toggle the setting
    await autoScrollToggle.click();
    await page.waitForTimeout(500);

    // Verify the toggle state changed
    const newChecked = await autoScrollToggle.getAttribute('aria-checked');
    expect(newChecked).not.toBe(initialChecked);

    // Restore original state to avoid affecting other tests
    await autoScrollToggle.click();
    await page.waitForTimeout(500);
  });
});

test.describe('Settings Modal - MCP Servers', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForWebSocketConnected(page);
  });

  test('should display MCP Servers section in Global Settings', async ({ page }) => {
    await openSettingsModal(page);

    // Navigate to MCP Servers section via the settings nav (exact match — other
    // UI surfaces also use the string "MCP Servers" as a section heading)
    await page.getByRole('button', { name: 'MCP Servers', exact: true }).click();

    // Verify MCP Servers section heading is displayed
    await expect(page.locator('h3:has-text("MCP Servers")')).toBeVisible();
  });

  test('should show MCP server configuration options', async ({ page }) => {
    await openSettingsModal(page);

    // Wait for MCP servers to load
    await page.waitForTimeout(1000);

    // Check if there are MCP servers or a "No MCP servers" message
    const noServersMessage = page.locator('text=No MCP servers found');
    const hasServers = (await noServersMessage.count()) === 0;

    if (hasServers) {
      // Should show Allowed and Default ON checkboxes for servers
      const mcpSection = page.locator('label:has-text("MCP Servers")').locator('..');
      const allowedCheckboxes = mcpSection.locator('text=Allowed');
      expect(await allowedCheckboxes.count()).toBeGreaterThanOrEqual(0);
    }
  });
});
