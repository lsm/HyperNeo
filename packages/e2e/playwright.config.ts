import { defineConfig, devices } from '@playwright/test';
import type { CoverageReportOptions } from 'monocart-reporter';
import { e2eTempDir, e2eWorkspaceDir, e2eDatabaseDir, e2eDatabasePath } from './test-env';

const e2ePort = process.env.E2E_PORT;
const baseURL = e2ePort
  ? `http://localhost:${e2ePort}`
  : process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:9283';

console.log(`\n📁 E2E Test Isolation:
   Temp Dir: ${e2eTempDir}
   Workspace: ${e2eWorkspaceDir}
   Database: ${e2eDatabasePath}
\n`);

const coverageOptions: CoverageReportOptions = {
  outputDir: './coverage',

  reports: [
    ['v8'],
    ['html-spa', { subdir: 'html' }],
    ['lcovonly', { file: 'lcov.info' }],
    ['console-summary'],
    ['json', { file: 'coverage.json' }],
  ],

  all: ['../web/src/**/*.{ts,tsx}'],

  sourceFilter: (sourcePath: string) => {
    if (process.env.DEBUG_COVERAGE) {
      console.log('Coverage source path:', sourcePath);
    }

    if (sourcePath.includes('anonymous')) return false;

    if (sourcePath.includes('node_modules')) return false;
    if (sourcePath.includes('/@vite/')) return false;
    if (sourcePath.includes('/@precss/')) return false;
    if (sourcePath.includes('chunk-')) return false;
    if (sourcePath.includes('.jsv=')) return false;
    if (sourcePath.endsWith('.js') && !sourcePath.endsWith('.tsx.js')) return false;

    if (
      sourcePath.includes('message-hub') ||
      sourcePath.includes('transport') ||
      sourcePath.includes('typed-hub') ||
      sourcePath.includes('router.ts')
    )
      return false;

    if (sourcePath.endsWith('.tsx')) return true;
    if (
      sourcePath.endsWith('.ts') &&
      !sourcePath.endsWith('.test.ts') &&
      !sourcePath.endsWith('.d.ts')
    )
      return true;

    return false;
  },

  watermarks: {
    statements: [50, 80],
    functions: [50, 80],
    branches: [50, 80],
    lines: [50, 80],
  },
};

const collectCoverage = process.env.COVERAGE === 'true';

export default defineConfig({
  testDir: './tests',

  fullyParallel: true,

  forbidOnly: !!process.env.CI,

  retries: process.env.CI ? 1 : 0,

  workers: process.env.CI ? 2 : 4,

  reporter: collectCoverage
    ? [
        ['monocart-reporter', { name: 'HyperNeo E2E Coverage', coverage: coverageOptions }],
        ['list'],
      ]
    : [['html', { outputFolder: 'playwright-report' }], ['list']],

  use: {
    baseURL: baseURL,

    trace: 'on-first-retry',

    screenshot: 'only-on-failure',

    video: 'retain-on-failure',

    actionTimeout: 60000,
  },

  timeout: 120000,

  expect: {
    timeout: 60000,
  },

  globalSetup: './global-setup.ts',

  globalTeardown: './global-teardown',

  projects: [
    {
      name: 'smoke',
      testDir: './tests/smoke',
      testMatch: '**/*.e2e.ts',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'read-only',
      testDir: './tests/read-only',
      testMatch: '**/*.e2e.ts',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'core',
      testDir: './tests/core',
      testMatch: '**/*.e2e.ts',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'features',
      testDir: './tests/features',
      testMatch: '**/*.e2e.ts',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'settings',
      testDir: './tests/settings',
      testMatch: '**/*.e2e.ts',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'responsive',
      testDir: './tests/responsive',
      testMatch: '**/*.e2e.ts',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'serial',
      testDir: './tests/serial',
      testMatch: '**/*.e2e.ts',
      use: { ...devices['Desktop Chrome'] },
      fullyParallel: false,
    },
  ],

  webServer: {
    command: `cd ../web && bun run build && cd ../cli && NODE_ENV=test bun run main.ts${e2ePort ? ` --port ${e2ePort}` : ''}`,
    url: baseURL,
    reuseExistingServer: !e2ePort && !!process.env.PLAYWRIGHT_BASE_URL,
    stdout: 'ignore',
    stderr: 'pipe',
    timeout: 120 * 1000,
    env: {
      NODE_ENV: 'test',
      DEFAULT_MODEL: 'sonnet',
      HYPERNEO_WORKSPACE_PATH: e2eWorkspaceDir,
      HYPERNEO_WORKSPACE_ROOT: e2eWorkspaceDir,
      DB_PATH: e2eDatabasePath,
      HYPERNEO_DISABLE_GOAL_PROCESSING: '1',
      ...(e2ePort ? { HYPERNEO_PORT: e2ePort } : {}),
    },
  },
});
