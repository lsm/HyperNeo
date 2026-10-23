import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import ts from 'typescript';

test('core service and prompt consume injected packs without importing pack implementations', () => {
  const core = join(import.meta.dirname, '../../../../src/lib/neo');
  const imports = ['service.ts', 'prompt.ts'].flatMap((file) =>
    ts
      .preProcessFile(readFileSync(join(core, file), 'utf8'), true)
      .importedFiles.map((entry) => resolve(core, entry.fileName))
      .filter((path) => path.startsWith(join(core, 'packs/')))
  );
  expect(imports).toEqual([]);
});
