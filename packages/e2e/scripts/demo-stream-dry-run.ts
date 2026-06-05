/**
 * NeoKai live UI demo dry-run
 *
 * Walks the demo script in a headless browser, captures screenshots,
 * and records breakages to `tmp/demo-screenshots/`.
 *
 * Run from packages/e2e:
 *   cd packages/e2e && bun run scripts/demo-stream-dry-run.ts
 *
 * Env:
 *   DEMO_BASE_URL    default http://localhost:8383
 *   DEMO_OUT_DIR     default ../../tmp/demo-screenshots
 */

import { chromium, type Page } from '@playwright/test';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const BASE_URL = process.env.DEMO_BASE_URL?.replace(/\/$/, '') || 'http://localhost:8383';
const OUT_DIR = resolve(process.env.DEMO_OUT_DIR || '../../tmp/demo-screenshots');
const DEMO_SPACE_NAME = 'dev-NeoKai';
const DEMO_TASK_TITLE = 'Demo task — do not execute';

mkdirSync(OUT_DIR, { recursive: true });

interface DemoSpaceResult {
  spaceId: string;
  workspacePath: string;
  created: boolean;
}

interface Breakage {
  step: string;
  message: string;
  screenshot?: string;
}

const breakages: Breakage[] = [];

function report(step: string, message: string, screenshot?: string) {
  breakages.push({ step, message, screenshot });
  console.error(`[${step}] ${message}`);
}

async function screenshot(page: Page, name: string): Promise<string> {
  const path = join(OUT_DIR, `${name}.png`);
  await page.screenshot({ path, fullPage: true });
  console.log(`  📸 ${path}`);
  return path;
}

async function safeStep(name: string, fn: () => Promise<void>, page: Page): Promise<void> {
  try {
    console.log(`\n▶ ${name}`);
    await fn();
  } catch (error) {
    const path = await screenshot(
      page,
      `breakage-${breakages.length}-${name.replace(/\s+/g, '_')}`
    );
    report(name, (error as Error).message, path);
  }
}

async function waitForAppReady(page: Page) {
  // The default route is /spaces; wait for the space switcher to render.
  await page.waitForLoadState('domcontentloaded');
  await page
    .locator('[data-testid="space-switcher"]')
    .waitFor({ state: 'visible', timeout: 20000 });
  await waitForWebSocketConnected(page, 20000);
  await page.waitForTimeout(1000);
}

async function waitForWebSocketConnected(page: Page, timeout = 15000) {
  await page.waitForFunction(
    () => {
      const hub = (window as any).__messageHub || (window as any).appState?.messageHub;
      return hub?.getState && hub.getState() === 'connected';
    },
    { timeout }
  );
}

async function ensureDemoSpace(page: Page): Promise<DemoSpaceResult> {
  await waitForWebSocketConnected(page);

  // Use a temp workspace path on the host. The daemon validates it exists.
  const demoWorkspacePath = resolve(`/tmp/neokai-demo-workspace-${Date.now()}`);
  mkdirSync(demoWorkspacePath, { recursive: true });

  return page.evaluate(
    async ({ name, workspacePath }) => {
      const hub = (window as any).__messageHub || (window as any).appState?.messageHub;
      if (!hub?.request) throw new Error('MessageHub not available');

      // Reuse existing space with the same name if present, and fetch its stored
      // workspacePath so the session we create is bound to the same path as the live UI.
      const list = (await hub.request('space.list', {})) as Array<{ id: string; name: string }>;
      const existing = list.find((s) => s.name === name);
      if (existing) {
        const fullSpace = (await hub.request('space.get', { id: existing.id })) as {
          id: string;
          workspacePath: string;
        };
        return { spaceId: fullSpace.id, workspacePath: fullSpace.workspacePath, created: false };
      }

      const space = (await hub.request('space.create', { name, workspacePath })) as {
        id: string;
      };
      return { spaceId: space.id, workspacePath, created: true };
    },
    { name: DEMO_SPACE_NAME, workspacePath: demoWorkspacePath }
  );
}

async function seedDemoTask(page: Page, spaceId: string): Promise<string | null> {
  return page.evaluate(
    async ({ spaceId, title }) => {
      const hub = (window as any).__messageHub || (window as any).appState?.messageHub;
      if (!hub?.request) throw new Error('MessageHub not available');

      // Archive any previous demo tasks with the same title so re-runs do not
      // pollute the Space with duplicates or leave stale draft/open tasks behind.
      // Some status transitions reject direct archival, so we transition through
      // an allowed intermediate state when necessary.
      const list = (await hub.request('spaceTask.list', {
        spaceId,
        includeArchived: true,
      })) as Array<{ id: string; title: string; status: string }>;
      for (const t of list) {
        if (t.title !== title || t.status === 'archived') continue;
        try {
          await hub.request('spaceTask.update', {
            spaceId,
            taskId: t.id,
            status: 'archived',
          });
        } catch {
          // Direct archival rejected; move to an intermediate terminal state first.
          await hub.request('spaceTask.update', {
            spaceId,
            taskId: t.id,
            status: 'cancelled',
          });
          await hub.request('spaceTask.update', {
            spaceId,
            taskId: t.id,
            status: 'archived',
          });
        }
      }

      // Create as blocked/human_input so the task renders SpaceTaskPane (thread
      // tab visible) without entering the runnable open-task pipeline.
      const task = (await hub.request('spaceTask.create', {
        spaceId,
        title,
        description: 'Harmless demo task used for UI dry-run only.',
        status: 'blocked',
        blockReason: 'human_input_requested',
      })) as { id: string };
      return task.id;
    },
    { spaceId, title: DEMO_TASK_TITLE }
  );
}

async function createDemoSession(
  page: Page,
  spaceId: string,
  workspacePath: string
): Promise<string | null> {
  return page.evaluate(
    async ({ sid, workspacePath }) => {
      const hub = (window as any).__messageHub || (window as any).appState?.messageHub;
      if (!hub?.request) throw new Error('MessageHub not available');
      const result = (await hub.request('session.create', {
        spaceId: sid,
        workspacePath,
        createdBy: 'human',
      })) as { sessionId: string };
      return result.sessionId;
    },
    { sid: spaceId, workspacePath }
  );
}

async function deleteDemoSession(page: Page, sessionId: string) {
  try {
    await page.evaluate(async (sid) => {
      const hub = (window as any).__messageHub || (window as any).appState?.messageHub;
      if (!hub?.request) return;
      await hub.request('session.delete', { sessionId: sid });
    }, sessionId);
  } catch {
    // best-effort cleanup
  }
}

async function deleteDemoSpace(page: Page, spaceId: string) {
  try {
    await page.evaluate(async (sid) => {
      const hub = (window as any).__messageHub || (window as any).appState?.messageHub;
      if (!hub?.request) return;
      await hub.request('space.delete', { id: sid });
    }, spaceId);
  } catch {
    // best-effort cleanup
  }
}

async function main() {
  console.log(`Dry-run against ${BASE_URL}`);
  console.log(`Output: ${OUT_DIR}`);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    baseURL: BASE_URL,
  });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);

  // Health check
  const health = await page.request.get(BASE_URL);
  if (!health.ok()) {
    report('startup', `Dev server not reachable at ${BASE_URL} (${health.status()})`);
    await browser.close();
    process.exitCode = 1;
    return;
  }

  let demoSpace: DemoSpaceResult | null = null;
  let demoTaskId: string | null = null;
  let createdSessionId: string | null = null;

  await safeStep(
    'open-app',
    async () => {
      await page.goto('/');
      await waitForAppReady(page);
      await screenshot(page, '00-app-ready');
    },
    page
  );

  await safeStep(
    'ensure-demo-space',
    async () => {
      demoSpace = await ensureDemoSpace(page);
      if (!demoSpace) throw new Error('space.create returned no id');
      console.log(
        `  spaceId=${demoSpace.spaceId} created=${demoSpace.created} workspacePath=${demoSpace.workspacePath}`
      );
    },
    page
  );

  const spaceId = demoSpace?.spaceId ?? null;
  const workspacePath = demoSpace?.workspacePath ?? '';

  await safeStep(
    'space-overview',
    async () => {
      if (!spaceId) throw new Error('no spaceId');
      await page.goto(`/space/${spaceId}`);
      await waitForWebSocketConnected(page);
      await page.locator('[data-testid="space-detail-dashboard"]').waitFor({ state: 'visible' });
      await screenshot(page, '01-space-overview');
    },
    page
  );

  await safeStep(
    'seed-task',
    async () => {
      if (!spaceId) throw new Error('no spaceId');
      demoTaskId = await seedDemoTask(page, spaceId);
      console.log(`  taskId=${demoTaskId}`);
    },
    page
  );

  await safeStep(
    'tasks-view',
    async () => {
      if (!spaceId) throw new Error('no spaceId');
      await page.goto(`/space/${spaceId}/tasks`);
      await page.locator('[data-testid="space-tasks-view"]').waitFor({ state: 'visible' });
      await screenshot(page, '02-tasks-view');
    },
    page
  );

  await safeStep(
    'open-task',
    async () => {
      if (!spaceId) throw new Error('no spaceId');
      if (!demoTaskId) throw new Error('no demoTaskId');
      // Navigate directly to the draft task so the dry-run does not depend on
      // which Tasks tab is currently active in the sidebar.
      await page.goto(`/space/${spaceId}/task/${demoTaskId}`);
      await waitForWebSocketConnected(page);
      // The task pane renders the thread panel directly; no explicit "Thread" tab text.
      await page.locator('[data-testid="task-thread-panel"]').waitFor({ state: 'visible' });
      await screenshot(page, '03-task-thread');
    },
    page
  );

  await safeStep(
    'agents-view',
    async () => {
      if (!spaceId) throw new Error('no spaceId');
      await page.goto(`/space/${spaceId}/agents`);
      await page.locator('[data-testid="space-detail-agent"]').waitFor({ state: 'visible' });
      // The agents page shows long-horizon agents; every new space gets a Coordinator.
      await page.getByText('Coordinator').first().waitFor({ state: 'visible', timeout: 15000 });
      await screenshot(page, '04-agents-view');
    },
    page
  );

  await safeStep(
    'forge-view',
    async () => {
      if (!spaceId) throw new Error('no spaceId');
      await page.goto(`/space/${spaceId}/forge`);
      await page.locator('[data-testid="space-detail-forge"]').waitFor({ state: 'visible' });
      await screenshot(page, '05-forge-view');
    },
    page
  );

  await safeStep(
    'create-session',
    async () => {
      if (!spaceId) throw new Error('no spaceId');
      // Drive the same UI path the operator uses: Sessions nav → Create session button.
      await page.goto(`/space/${spaceId}/sessions`);
      await page.getByRole('button', { name: 'Create session' }).first().click();
      await page.waitForURL(
        new RegExp(`^${BASE_URL.replace(/\//g, '\\/')}\\/space\\/${spaceId}\\/session\\/.+`)
      );
      const sessionId = page.url().split('/session/')[1]?.split('?')[0];
      if (!sessionId) throw new Error('Could not extract sessionId from URL');
      createdSessionId = sessionId;
      await page
        .locator('textarea[placeholder="Ask or make anything..."]')
        .first()
        .waitFor({ state: 'visible' });
      await page
        .locator('textarea[placeholder="Ask or make anything..."]')
        .first()
        .fill('Hi NeoKai — can you summarize what this Space is working on?');
      await screenshot(page, '06-session-input');
    },
    page
  );

  await safeStep(
    'settings-skills',
    async () => {
      await page.goto('/settings?tab=skills');
      // Wait for SkillsRegistry content (the "Add Skill" button) rather than the sidebar nav.
      await page.getByRole('button', { name: 'Add Skill' }).waitFor({ state: 'visible' });
      await screenshot(page, '07-settings-skills');
    },
    page
  );

  await safeStep(
    'return-to-spaces',
    async () => {
      await page.goto('/spaces');
      await page.locator('[data-testid="space-switcher"]').waitFor({ state: 'visible' });
      await screenshot(page, '08-spaces-list');
    },
    page
  );

  await safeStep(
    'cleanup',
    async () => {
      if (createdSessionId) await deleteDemoSession(page, createdSessionId);
      // Default: keep the demo Space so it remains available for the live stream.
      // Set DEMO_CLEANUP_SPACE=1 to delete a Space created by this run (useful for CI).
      if (process.env.DEMO_CLEANUP_SPACE === '1' && demoSpace?.created && spaceId) {
        await deleteDemoSpace(page, spaceId);
      }
    },
    page
  );

  await browser.close();

  // Write reports
  const reportPath = join(OUT_DIR, 'dry-run-report.json');
  writeFileSync(
    reportPath,
    JSON.stringify(
      {
        baseURL: BASE_URL,
        timestamp: new Date().toISOString(),
        breakages,
        passed: breakages.length === 0,
      },
      null,
      2
    ),
    'utf-8'
  );

  const mdPath = join(OUT_DIR, 'dry-run-report.md');
  const mdLines = [
    '# NeoKai Live UI Demo — Dry-Run Report',
    '',
    `- **Base URL:** ${BASE_URL}`,
    `- **Time:** ${new Date().toISOString()}`,
    `- **Result:** ${breakages.length === 0 ? 'All steps passed' : `${breakages.length} breakage(s)`}`,
    '',
    '## Screenshots',
    '',
    'Captured in `tmp/demo-screenshots/`.',
    '',
    '## Breakages',
    '',
  ];
  if (breakages.length === 0) {
    mdLines.push('None.');
  } else {
    for (const b of breakages) {
      mdLines.push(`### ${b.step}`);
      mdLines.push(`- **Message:** ${b.message}`);
      if (b.screenshot) mdLines.push(`- **Screenshot:** ${b.screenshot}`);
      mdLines.push('');
    }
  }
  writeFileSync(mdPath, mdLines.join('\n'), 'utf-8');

  console.log(`\nReports written:`);
  console.log(`  ${reportPath}`);
  console.log(`  ${mdPath}`);

  if (breakages.length > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error('Fatal dry-run error:', error);
  process.exitCode = 1;
});
