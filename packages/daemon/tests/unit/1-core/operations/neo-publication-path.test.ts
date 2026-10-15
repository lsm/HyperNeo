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

describe('one Neo publication path', () => {
  test('only NeoService.commitPublication writes a publication; every caller goes through it', () => {
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
    const commit = service.slice(
      service.indexOf('this.commitPublication = createNeoPublicationCommit('),
      service.indexOf('published: (input')
    );
    expect(commit).toContain('this.appendPublication(input)');
    expect(
      service.match(/append: \(input(, consultationId)?\) =>\s*this\.commitPublication\(/g)
    ).toHaveLength(2);
  });
});
