#!/usr/bin/env bun

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

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
    const output = runGit(['diff', '--name-only', baseRef, 'HEAD']);
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

function stripComments(source: string): string {
  let output = '';
  let quote: string | null = null;
  let escaped = false;

  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    const next = source[index + 1];

    if (quote) {
      output += char;
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }

    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      output += char;
      continue;
    }

    if (char === '/' && next === '/') {
      while (index < source.length && source[index] !== '\n') {
        output += ' ';
        index++;
      }
      output += source[index] ?? '';
      continue;
    }

    if (char === '/' && next === '*') {
      output += '  ';
      index += 2;
      while (index < source.length && !(source[index] === '*' && source[index + 1] === '/')) {
        output += source[index] === '\n' ? '\n' : ' ';
        index++;
      }
      output += '  ';
      index++;
      continue;
    }

    output += char;
  }

  return output;
}

function findCallEnd(source: string, openParenIndex: number): number {
  let depth = 0;
  let quote: string | null = null;
  let escaped = false;

  for (let index = openParenIndex; index < source.length; index++) {
    const char = source[index];

    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }

    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      continue;
    }

    if (char === '(') depth++;
    if (char === ')') {
      depth--;
      if (depth === 0) return index;
    }
  }

  return -1;
}

function blankDisabledTestCalls(source: string): string {
  const disabledCallPattern = /\b(?:describe|it|test)\.(?:skip|todo)\s*\(/g;
  let output = source;
  for (const match of source.matchAll(disabledCallPattern)) {
    const openParenIndex = (match.index ?? 0) + match[0].length - 1;
    const end = findCallEnd(source, openParenIndex);
    if (end === -1) continue;
    output =
      output.slice(0, match.index) +
      ' '.repeat(end - (match.index ?? 0) + 1) +
      output.slice(end + 1);
  }
  return output;
}

function normalizeCallLine(line: string): string {
  let normalized = line.trim();
  if (normalized.startsWith('const ')) {
    normalized = normalized.replace(/^const\s+\w+\s*=\s*/, '');
  }
  return normalized;
}

function countBraces(line: string): number {
  let depth = 0;
  let quote: string | null = null;
  let escaped = false;

  for (const char of line) {
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }

    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      continue;
    }

    if (char === '{') depth++;
    if (char === '}') depth--;
  }

  return depth;
}

function startsNestedFunction(line: string): boolean {
  return (
    /^(?:async\s+)?function\b/.test(line) ||
    /^(?:const|let|var)\s+\w+\s*=\s*(?:async\s+)?(?:\([^)]*\)|\w+)\s*=>\s*\{/.test(line)
  );
}

function hasFocusedTest(source: string): boolean {
  return /\b(?:describe|it|test)\.only\s*\(/.test(stripComments(source));
}

function parseTestedHandlers(source: string): Set<string> {
  const executableSource = blankDisabledTestCalls(stripComments(source));
  const tested = new Set<string>();
  for (const match of executableSource.matchAll(/\b(?:it|test)\s*\(/g)) {
    const openParenIndex = (match.index ?? 0) + match[0].length - 1;
    const end = findCallEnd(executableSource, openParenIndex);
    if (end === -1) continue;
    const testBody = executableSource.slice(openParenIndex, end + 1);
    let nestedFunctionDepth = 0;
    for (const line of testBody.split('\n')) {
      const normalizedLine = normalizeCallLine(line);
      if (nestedFunctionDepth > 0 || startsNestedFunction(normalizedLine)) {
        nestedFunctionDepth = Math.max(0, nestedFunctionDepth + countBraces(normalizedLine));
        continue;
      }

      const callMatch = normalizedLine.match(
        /^(?:return\s+)?(?:await\s+)?(?:expect\()?call\(\s*['"]([^'"]+)['"]/
      );
      const method = callMatch?.[1];
      if (method?.startsWith('spaceTask.')) tested.add(method);
    }
  }
  return tested;
}

function main() {
  if (!existsSync(handlerFile)) fail(`Missing handler file: ${handlerFile}`);
  if (!existsSync(testFile)) fail(`Missing test file: ${testFile}`);

  const files = changedFiles();
  if (!files.has(handlerFile) && !files.has(testFile)) return;

  const handlerSource = readFileSync(handlerFile, 'utf8');
  const testSource = readFileSync(testFile, 'utf8');
  if (hasFocusedTest(testSource)) {
    fail(`Focused tests are not allowed in ${testFile}. Remove .only before counting coverage.`);
  }
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
