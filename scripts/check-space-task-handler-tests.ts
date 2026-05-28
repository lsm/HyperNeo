#!/usr/bin/env bun

import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const handlerFile = 'packages/daemon/src/lib/rpc-handlers/space-task-handlers.ts';
const testFile = 'packages/daemon/tests/unit/2-handlers/rpc-handlers/space-task-handlers.test.ts';
const baseRef = process.env.GITHUB_BASE_REF
  ? `origin/${process.env.GITHUB_BASE_REF}`
  : (process.env.SPACE_TASK_HANDLER_TEST_BASE ?? 'origin/dev');

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function runGit(args: string[]): string {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

function parseHandlers(source: string): Set<string> {
  return new Set(
    Array.from(source.matchAll(/onRequest\('([^']+)'/g), (match) => match[1]).filter((method) =>
      method.startsWith('spaceTask.')
    )
  );
}

function changedFiles(): Set<string> {
  try {
    const mergeBase = runGit(['merge-base', baseRef, 'HEAD']);
    const output = runGit(['diff', '--name-only', `${mergeBase}...HEAD`]);
    return new Set(output ? output.split('\n') : []);
  } catch (err) {
    const message = `Unable to compare branch against ${baseRef}. Ensure base ref is fetched. ${
      err instanceof Error ? err.message : String(err)
    }`;
    if (process.env.CI) fail(message);

    console.warn(`${message}\nSkipping space task handler test gate for this local check.`);
    return new Set();
  }
}

function parseTestedHandlers(source: string): Set<string> {
  return new Set(
    Array.from(source.matchAll(/\bcall\(\s*['"]([^'"]+)['"]/g), (match) => match[1]).filter(
      (method) => method.startsWith('spaceTask.')
    )
  );
}

function main() {
  if (!existsSync(handlerFile)) fail(`Missing handler file: ${handlerFile}`);
  if (!existsSync(testFile)) fail(`Missing test file: ${testFile}`);

  const files = changedFiles();
  if (!files.has(handlerFile)) return;

  const handlerSource = readFileSync(handlerFile, 'utf8');
  const testSource = readFileSync(testFile, 'utf8');
  const methods = parseHandlers(handlerSource);
  const testedMethods = parseTestedHandlers(testSource);
  const missing = Array.from(methods).filter((method) => !testedMethods.has(method));

  if (missing.length > 0) {
    fail(
      `Missing tests for RPC handlers in ${handlerFile}:\n` +
        missing.map((method) => `  - ${method}`).join('\n') +
        `\nAdd at least one handler-path test in ${testFile} for each method.`
    );
  }
}

main();
