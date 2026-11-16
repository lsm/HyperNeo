import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const packages = fileURLToPath(new URL('../../../../', import.meta.url));
const PACK_OPERATION_WRAPPER = 'daemon/src/lib/neo/operations.ts';

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : files(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

function builtPipelineNames(source: string): string[] {
  const calls = source.matchAll(
    /superpipe\s*(?:<[^>]*>)?\s*\((?:[^()]|\([^()]*\))*\)\s*\(\s*([^,)]+)/g
  );
  return [...calls]
    .map((call) => call[1].trim())
    .filter((name) => !/^'[^'$]*'$|^"[^"]*"$|^`[^`$]*`$/.test(name));
}

describe('pipeline names', () => {
  test('recognizes a name built at runtime', () => {
    expect(builtPipelineNames("superpipe({ deps })('space.goal.update')")).toEqual([]);
    expect(builtPipelineNames('superpipe({})(name)')).toEqual(['name']);
    expect(builtPipelineNames("superpipe({})('neo.' + action)")).toEqual(["'neo.' + action"]);
  });

  test('every pipeline is named by a literal where it is built', () => {
    const built = ['cli', 'daemon', 'space', 'web'].flatMap((pkg) =>
      files(join(packages, pkg, 'src')).flatMap((file) =>
        builtPipelineNames(readFileSync(file, 'utf8')).map(
          (name) => `${relative(packages, file)}: ${name}`
        )
      )
    );
    expect(built).toEqual([`${PACK_OPERATION_WRAPPER}: name`]);
  });
});
