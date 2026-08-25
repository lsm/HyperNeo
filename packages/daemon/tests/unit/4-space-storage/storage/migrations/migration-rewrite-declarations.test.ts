import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const migrationsPath = new URL('../../../../../src/storage/schema/migrations.ts', import.meta.url);

const importedMigrationPattern = /import \{ (\w+)(?: as (\w+))? \} from '\.\/(m[\w-]+)'/g;

interface MigrationCall {
  marker: string;
  functionName: string;
}

function migrationCalls(source: string, runner: 'run' | 'rewrite'): MigrationCall[] {
  const pattern = new RegExp(
    `\\b${runner}\\((migrationMarkerKey\\(\\d+\\)|'migration_room_cleanup'), \\(\\) => (runMigration\\w+)\\(db\\)\\)`,
    'g'
  );
  return [...source.matchAll(pattern)].map((match) => ({
    marker: match[1] ?? '',
    functionName: match[2] ?? '',
  }));
}

function importedMigrationBodies(source: string): Map<string, string> {
  const bodies = new Map<string, string>();
  for (const match of source.matchAll(importedMigrationPattern)) {
    const localName = match[2] ?? match[1];
    const moduleUrl = new URL(`./${match[3]}.ts`, migrationsPath);
    const moduleBodies = functionBodies(readFileSync(moduleUrl, 'utf8'));
    const reachable = match[1] ? reachableBody(match[1], moduleBodies) : '';
    if (reachable && localName) bodies.set(localName, reachable);
  }
  return bodies;
}

function functionBodies(source: string): Map<string, string> {
  const declarations = [...source.matchAll(/(?:^|\n)(?:export )?function (\w+)\(/g)].map(
    (match) => ({ name: match[1] ?? '', start: match.index ?? 0 })
  );
  return new Map(
    declarations.map((declaration, index) => [
      declaration.name,
      source.slice(declaration.start, declarations[index + 1]?.start ?? source.length),
    ])
  );
}

function reachableBody(functionName: string, bodies: Map<string, string>): string {
  const visited = new Set<string>();
  const pending = [functionName];
  let reachable = '';
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || visited.has(current)) continue;
    visited.add(current);
    const body = bodies.get(current);
    if (!body) continue;
    reachable += body;
    for (const match of body.matchAll(/\b(\w+)\(/g)) {
      const callee = match[1];
      if (callee && bodies.has(callee) && !visited.has(callee)) pending.push(callee);
    }
  }
  return reachable;
}

describe('migration rewrite declarations', () => {
  test('every table-rebuilding migration uses the rewrite runner', () => {
    const source = readFileSync(migrationsPath, 'utf8');
    const bodies = new Map([...functionBodies(source), ...importedMigrationBodies(source)]);
    const untagged = migrationCalls(source, 'run')
      .filter((call) => {
        const body = reachableBody(call.functionName, bodies);
        return (
          (/\bDROP TABLE\b/.test(body) && /\bALTER TABLE\b[\s\S]*\bRENAME TO\b/.test(body)) ||
          /\bALTER TABLE\b[\s\S]*\bDROP COLUMN\b/.test(body)
        );
      })
      .map((call) => call.marker);

    expect(untagged).toEqual([]);
    expect(migrationCalls(source, 'rewrite').map((call) => call.marker)).toContain(
      'migrationMarkerKey(183)'
    );
  });
});
