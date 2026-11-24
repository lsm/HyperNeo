import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
const { chromium } = createRequire(import.meta.url)('playwright');
const [port, code, output, run] = process.argv.slice(2);
const base = `http://127.0.0.1:${port}`;
const browser = await chromium.launch({
  headless: true,
  ...(process.env.VERIFY_BROWSER ? { executablePath: process.env.VERIFY_BROWSER } : {}),
});
const before = process.env.OXAP_UI_BEFORE === '1';
let sessionPath;
try {
  const initial = await browser.newPage();
  await initial.goto(`${base}/pair#${code}`);
  await initial.getByLabel('Name for this browser').fill('Synthetic browser');
  await initial.getByRole('button', { name: 'Pair this browser' }).click();
  await initial.getByText('This browser is paired.').waitFor();
  const storageState = await initial.context().storageState();
  await initial.close();
  for (const theme of ['light', 'dark']) {
    const phone = theme === 'dark';
    const context = await browser.newContext({
      storageState,
      colorScheme: theme,
      viewport: phone ? { width: 390, height: 844 } : { width: 1280, height: 800 },
      hasTouch: phone,
    });
    const page = await context.newPage();
    assert.equal(await page.evaluate(() => matchMedia('(pointer: coarse)').matches), phone);
    await page.goto(`${base}/sessions`);
    if (theme === 'light') {
      await page.getByRole('alert').getByText('Synthetic provider lookup failure').waitFor();
      await page.getByRole('button', { name: 'Retry' }).click();
      await page.getByRole('alert').waitFor({ state: 'hidden' });
      console.log('Provider lookup error surfaced and retry succeeded');
    }
    await page.evaluate(
      ({ theme }) => {
        localStorage.setItem(
          'hyperneo_new_chat_selection',
          JSON.stringify({
            model: { id: 'codex-6-luna', provider: 'anthropic-codex' },
            thinkingLevel: 'off',
            sandbox: true,
          })
        );
        localStorage.setItem('theme', theme);
      },
      { theme }
    );
    await page.reload();
    await page
      .getByRole('button', { name: 'Choose model, client and thinking' })
      .and(page.locator('[aria-description="Client: OXAP Codex"]'))
      .click();
    await page.getByRole('button', { name: /Model(?: & thinking)?, Synthetic Codex/ }).click();
    await page.getByRole('group', { name: 'Models', exact: true }).getByText('Synthetic Codex').waitFor();
    const newThinking = page.getByRole('slider', { name: 'Thinking' });
    await newThinking.waitFor({ timeout: 5000 });
    assert.equal(await newThinking.getAttribute('max'), '1');
    await newThinking.press('End');
    assert.equal(await newThinking.getAttribute('aria-valuetext'), 'High');
    assert.equal(await page.getByRole('button', { name: 'Sandbox' }).count(), 0);
    await page.screenshot({ path: `${output}/oxap-create-${theme}.png`, animations: 'disabled' });
    if (theme === 'light') {
      await page.getByPlaceholder('Ask anything to start a new chat...').fill('Hello');
      await page.getByRole('button', { name: 'Start chat' }).click();
      await page.waitForURL(/\/session\//, { timeout: 15000 });
      assert.equal(await page.getByText('OXAP Codex does not take a thinking level.').count(), 0);
      sessionPath = new URL(page.url()).pathname;
    }
    if (!phone) {
      const settingsId = /SETTINGS_SESSION=([^\s]+)/.exec(readFileSync(`${output}/daemon.log`, 'utf8'))?.[1];
      assert(settingsId);
      sessionPath = `/session/${settingsId}`;
    }
    await page.goto(`${base}${sessionPath}`);
    await page.getByRole('button', { name: 'Choose model and thinking' }).waitFor();
    if (!before) {
      await page.getByText(/This harness accepts text only/).waitFor();
      await page.getByTitle('More options').click();
      const attach = page.getByRole('button', { name: 'Attach image' });
      assert.equal(await attach.isDisabled(), true);
      const separators = await attach.evaluate(el => [...el.parentElement.children].filter(child => child.classList.contains('h-px') && getComputedStyle(child).display !== 'none').length);
      await page.screenshot({ path: `${output}/oxap-menu-${theme}.png`, animations: 'disabled' });
      assert.equal(separators, 1, 'OXAP attachment menu must show one separator');
      assert.equal(await page.getByRole('button', { name: 'Tools', exact: true }).count(), 0);
      await page.getByTitle('More options').click();
    }
    await page.getByRole('button', { name: 'Choose model and thinking' }).click();
    const oxapMenu = page.getByRole('group', { name: 'Model and thinking settings' });
    const thinking = oxapMenu.getByRole('slider', { name: 'Thinking' });
    await thinking.waitFor();
    assert.equal(await thinking.getAttribute('max'), '1');
    assert.equal(await thinking.getAttribute('aria-valuetext'), phone ? 'Low' : 'High');
    assert.equal(await oxapMenu.getByText('Synthetic SDK Model').count(), 0);
    await page.screenshot({ path: `${output}/oxap-thinking-${phone ? 'phone' : 'desktop'}.png`, animations: 'disabled' });
    if (!phone) {
      await thinking.press('Home');
      await page.getByRole('img', { name: 'Thinking: Low' }).waitFor();
      await page.reload();
      await page.getByRole('img', { name: 'Thinking: Low' }).waitFor();
      await page.getByRole('button', { name: 'Choose model and thinking' }).click();
    }
    await page.getByRole('button', { name: 'Close model settings' }).click();
    await page.getByTitle('More options').click();
    assert.equal(await page.getByRole('button', { name: 'Tools', exact: true }).count(), 0);
    await page.screenshot({ path: `${output}/oxap-tools-${theme}.png`, animations: 'disabled' });
    await page.getByTitle('More options').click();
    await page.screenshot({ path: `${output}/oxap-chat-${theme}.png`, animations: 'disabled' });
    await page.goto(`${base}/settings?tab=providers`);
    await page.getByText('Synthetic OXAP Codex', { exact: true }).first().click();
    if (!before) {
      assert.equal(await page.getByLabel('Harness', { exact: true }).inputValue(), 'oxap-codex');
      await page.getByLabel('Harness executable').waitFor();
      await page.getByText('synthetic-fixture', { exact: true }).waitFor();
    }
    await page.screenshot({ path: `${output}/oxap-provider-${theme}.png`, animations: 'disabled' });
    if (!before && theme === 'dark') {
      const executable = page.getByLabel('Harness executable');
      const savedExecutable = await executable.inputValue();
      await executable.fill('relative');
      await page.getByRole('button', { name: 'Save harness' }).click();
      await page.getByText(/needs an absolute executable path/).waitFor();
      await executable.fill(savedExecutable);
      await page.getByLabel('Harness', { exact: true }).selectOption('sdk');
      await page.getByRole('button', { name: 'Save harness' }).click();
      await page.getByText('Harness saved').waitFor();
      await page.reload();
      await page.getByText('Synthetic OXAP Codex', { exact: true }).first().click();
      assert.equal(await page.getByLabel('Harness', { exact: true }).inputValue(), 'sdk');
      console.log('Invalid executable refused; switching back to Claude Code persisted');
      const created = JSON.parse(execFileSync('bun', ['.claude/skills/verify/rpc.ts', 'rpc:session.create', JSON.stringify({ title: 'Provider retry proof', workspacePath: `${run}/home`, config: { provider: 'anthropic', model: 'synthetic-sdk', queryMode: 'manual' } })], { encoding: 'utf8', env: { ...process.env, HYPERNEO_DATA_DIR: `${run}/data`, VERIFY_PORT: port } })).reply;
      assert(created.sessionId);
      writeFileSync(`${run}/fail-provider-list`, '');
      await page.goto(`${base}/session/${created.sessionId}`);
      await page.getByRole('button', { name: 'Choose model and thinking' }).click();
      await page.getByRole('alert').getByText(/Could not load providers/).waitFor();
      assert(await page.getByText('Synthetic SDK Model').count());
      await page.screenshot({ path: `${output}/sdk-provider-error.png`, animations: 'disabled' });
      unlinkSync(`${run}/fail-provider-list`);
      await page.getByRole('button', { name: 'Retry providers' }).click();
      await page.getByRole('alert').waitFor({ state: 'detached' });
      await page.screenshot({ path: `${output}/sdk-provider-retry.png`, animations: 'disabled' });
      console.log('SDK picker kept its model after lookup failure and recovered on retry');
      await page.goto(`${base}/settings?tab=providers`);
      await page.getByText('Synthetic OXAP Codex', { exact: true }).first().click();
      await page.getByLabel('Harness', { exact: true }).selectOption('oxap-codex');
      await page.getByLabel('Harness executable').fill('/synthetic/codex');
      await page.getByRole('button', { name: 'Save harness' }).click();
      await page.waitForTimeout(10_500);
      assert.equal(await page.getByRole('button', { name: 'Save harness' }).isDisabled(), true);
      assert.equal(await page.getByText(/Request timeout/).count(), 0);
      await page.getByText('Harness saved').waitFor({ timeout: 15000 });
      await page.reload();
      await page.getByText('Synthetic OXAP Codex', { exact: true }).first().click();
      assert.equal(await page.getByLabel('Harness', { exact: true }).inputValue(), 'oxap-codex');
      await page.getByText('Version:', { exact: true }).waitFor();
      await page.getByText('SHA-256:', { exact: true }).waitFor();
      for (const appearance of ['light', 'dark']) {
        await page.evaluate((value) => localStorage.setItem('theme', value), appearance);
        await page.reload();
        await page.getByText('Synthetic OXAP Codex', { exact: true }).first().click();
        await page.getByText('SHA-256:', { exact: true }).waitFor();
        const path = page.locator('dt').filter({ hasText: 'Path:' }).locator('..').locator('dd');
        assert((await path.textContent()).includes('/oxap'));
        const sha = page.locator('dt').filter({ hasText: 'SHA-256:' }).locator('..').locator('dd');
        assert.match(await sha.textContent(), /^[a-f0-9]{64}$/);
        await page.screenshot({ path: `${output}/hub-installed-${appearance}.png`, animations: 'disabled', mask: [path], maskColor: appearance === 'dark' ? '#27272d' : '#f0f0f2' });
      }
      console.log('Delayed hub replacement saved and the installed hub persisted');
      for (const appearance of ['light', 'dark']) {
        await page.evaluate((value) => localStorage.setItem('theme', value), appearance);
        await page.goto(`${base}/session/${created.sessionId}`);
        await page.getByRole('button', { name: 'Choose model and thinking' }).click();
        const sdkMenu = page.getByRole('group', { name: 'Model and thinking settings' });
        await sdkMenu.getByRole('slider', { name: 'Thinking' }).waitFor();
        await sdkMenu.getByText('Synthetic SDK Model').waitFor();
        assert.equal(await sdkMenu.getByText('Synthetic Codex').count(), 0);
        await sdkMenu.screenshot({ path: `${output}/sdk-picker-${appearance}.png`, animations: 'disabled' });
        await page.getByRole('button', { name: 'Close model settings' }).click();
        await page.getByTitle('More options').click();
        await page.getByTitle('More options').locator('..').screenshot({ path: `${output}/sdk-actions-${appearance}.png`, animations: 'disabled' });
        await page.getByRole('button', { name: 'Tools', exact: true }).click();
        const tools = page.getByRole('dialog', { name: 'Tools' });
        await tools.getByRole('button', { name: 'Advanced settings' }).click();
        await tools.getByText('MCP Servers', { exact: true }).first().waitFor();
        await tools.screenshot({ path: `${output}/sdk-tools-${appearance}.png`, animations: 'disabled' });
      }


      const authSession = /AUTH_SESSION=([a-f0-9-]+)/.exec(readFileSync(`${output}/daemon.log`, 'utf8'))?.[1];
      assert(authSession);
      await page.goto(`${base}/session/${authSession}`);
      const authLink = page.getByRole('link', { name: /https:\/\/example\.com\/device/ });
      await page.getByText('Open https://example.com/device.', { exact: false }).first().waitFor();
      await page.screenshot({ path: `${output}/auth-link.png`, animations: 'disabled' });
      assert.equal(await authLink.getAttribute('href'), 'https://example.com/device');
      assert.equal(await authLink.textContent(), 'https://example.com/device');
      console.log('Authentication link excludes surrounding punctuation');
    }
    await context.close();
  }
} finally {
  await browser.close();
}
