#!/usr/bin/env bun

import { readFileSync } from 'node:fs';
import { Glob } from 'bun';
import { OPERATION_NAMES } from '../packages/shared/src/types/operation-names.ts';

const SOURCE_ROOT = 'packages/daemon/src';
const DEFINITION = /defineOperation\(\{\s*name:\s*'([^']+)'/g;

function definedNames(): Map<string, string> {
  const found = new Map<string, string>();
  for (const file of new Glob('**/*.ts').scanSync(SOURCE_ROOT)) {
    const path = `${SOURCE_ROOT}/${file}`;
    for (const match of readFileSync(path, 'utf8').matchAll(DEFINITION)) {
      found.set(match[1], path);
    }
  }
  return found;
}

const defined = definedNames();
const declared = new Set<string>(OPERATION_NAMES);
const missing = [...defined.keys()].filter((name) => !declared.has(name)).sort();
const stale = [...declared].filter((name) => !defined.has(name)).sort();

if (missing.length === 0 && stale.length === 0) {
  console.log(`operation names: ${defined.size} defined, all declared.`);
  process.exit(0);
}

if (missing.length > 0) {
  console.error(
    'Operations defined but absent from OPERATION_NAMES ' +
      '(packages/shared/src/types/operation-names.ts):'
  );
  for (const name of missing) console.error(`  ${name} — ${defined.get(name)}`);
}
if (stale.length > 0) {
  console.error(
    'Names declared in OPERATION_NAMES with no defineOperation call — ' +
      'remove them so call sites stop type-checking:'
  );
  for (const name of stale) console.error(`  ${name}`);
}
process.exit(1);
