import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { mkdirSync, existsSync, writeFileSync } from 'fs';
import { randomUUID } from 'crypto';

const testRunId = `e2e-${Date.now()}-${randomUUID().slice(0, 8)}`;
export const e2eTempDir = join(tmpdir(), 'hyperneo-e2e', testRunId);
export const e2eWorkspaceDir = join(e2eTempDir, 'workspace');
export const e2eDatabaseDir = join(e2eTempDir, 'database');
export const e2eDatabasePath = join(e2eDatabaseDir, 'daemon.db');

if (!existsSync(e2eWorkspaceDir)) {
  mkdirSync(e2eWorkspaceDir, { recursive: true });
}
if (!existsSync(e2eDatabaseDir)) {
  mkdirSync(e2eDatabaseDir, { recursive: true });
}

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
