#!/usr/bin/env bun

import { readFileSync } from 'node:fs';
import { Glob } from 'bun';

const SOURCE_ROOT = 'packages/daemon/src';
const ALLOWED = new Set([
  `${SOURCE_ROOT}/lib/neo/human-card.ts`,
  `${SOURCE_ROOT}/storage/repositories/neo-ask-todo-repository.ts`,
]);
const WRITE = /\.(askQuestion|replaceQuestion)\(/;

const bypasses = [...new Glob('**/*.ts').scanSync(SOURCE_ROOT)]
  .map((file) => `${SOURCE_ROOT}/${file}`)
  .filter((path) => !ALLOWED.has(path))
  .flatMap((path) =>
    readFileSync(path, 'utf8')
      .split('\n')
      .flatMap((line, index) => (WRITE.test(line) ? [`  ${path}:${index + 1}`] : []))
  );

if (bypasses.length === 0) {
  console.log('neo card door: every human card goes through lib/neo/human-card.ts.');
  process.exit(0);
}

console.error('Human cards must open through openHumanCard (lib/neo/human-card.ts):');
for (const bypass of bypasses) console.error(bypass);
process.exit(1);
