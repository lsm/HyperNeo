import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, test } from 'bun:test';

const SRC = join(import.meta.dirname, '../../../../src');
const WRITES = /publications\.append\(|appendPublication\(/g;

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return name.endsWith('.ts') ? [path] : [];
  });
}

describe('Neo publication persistence paths', () => {
  test('publication delivery uses the writer and only idle notices retain the legacy append', () => {
    const writers = sources(SRC)
      .filter((path) => !path.includes('/storage/'))
      .flatMap((path) =>
        [...readFileSync(path, 'utf8').matchAll(WRITES)].map(
          (match) => `${relative(SRC, path)}:${match[0]}`
        )
      );
    expect(writers.sort()).toEqual(
      [
        'lib/neo/service.ts:appendPublication(',
        'lib/neo/service.ts:appendPublication(',
        'lib/neo/service.ts:publications.append(',
      ].sort()
    );
    const service = readFileSync(join(SRC, 'lib/neo/service.ts'), 'utf8');
    expect(
      service.match(
        /append: \(input\) => this\.db\.gateway\.call\(neoPublicationWrites, 'append', input\)/g
      )
    ).toHaveLength(1);
  });
});
