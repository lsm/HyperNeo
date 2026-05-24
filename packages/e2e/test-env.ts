/**
 * Shared test environment configuration for E2E tests.
 *
 * This module is imported by both playwright.config.ts and global-setup.ts.
 * Node.js caches modules, so this is only evaluated ONCE — both files
 * get the same exported values.
 *
 * NOTE: This module has side effects (creates temp directories).
 * It should only be imported by setup/teardown/config files.
 */

import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { mkdirSync, existsSync, writeFileSync } from 'fs';
import { randomUUID } from 'crypto';

// Compute workspace path once (Node.js caches this module)
const testRunId = `e2e-${Date.now()}-${randomUUID().slice(0, 8)}`;
export const e2eTempDir = join(tmpdir(), 'neokai-e2e', testRunId);
export const e2eWorkspaceDir = join(e2eTempDir, 'workspace');
export const e2eDatabaseDir = join(e2eTempDir, 'database');
export const e2eDatabasePath = join(e2eDatabaseDir, 'daemon.db');

// Ensure directories exist (only created once due to module caching)
if (!existsSync(e2eWorkspaceDir)) {
  mkdirSync(e2eWorkspaceDir, { recursive: true });
}
if (!existsSync(e2eDatabaseDir)) {
  mkdirSync(e2eDatabaseDir, { recursive: true });
}

// Seed the workspace with sample files so the daemon's FileIndex has entries
// for reference autocomplete file/folder search tests. These must be created
// at config evaluation time (before the webServer starts) because the FileIndex
// scans the workspace during server init — before globalSetup runs.
const seedFiles: Record<string, string> = {
  'package.json': '{ "name": "e2e-test-workspace", "version": "1.0.0" }',
  'README.md': '# E2E Test Workspace',
  'src/index.ts': 'export const hello = "world";',
  'src/utils/helpers.ts': 'export function add(a: number, b: number) { return a + b; }',
  'docs/guide.md': '# User Guide',
};
for (const [relPath, content] of Object.entries(seedFiles)) {
  const absPath = join(e2eWorkspaceDir, relPath);
  const dir = dirname(absPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  if (!existsSync(absPath)) {
    writeFileSync(absPath, content, 'utf-8');
  }
}
