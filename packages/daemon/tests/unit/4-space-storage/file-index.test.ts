import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FileIndex } from '../../../src/lib/file-index';

const NO_POLL = 9_999_999;

function indexedPaths(idx: FileIndex): string[] {
  return idx.search('', 10_000).map((e) => e.path);
}

async function makeWorkspace(): Promise<string> {
  const path = join(
    tmpdir(),
    `file-index-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  await mkdir(path, { recursive: true });
  return path;
}

describe('FileIndex (Unit)', () => {
  let workspace: string;
  let idx: FileIndex;

  beforeEach(async () => {
    workspace = await makeWorkspace();
  });

  afterEach(async () => {
    if (idx) idx.dispose();
    await rm(workspace, { recursive: true, force: true });
  });

  describe('init', () => {
    it('isReady() returns false before init', () => {
      idx = new FileIndex(workspace, NO_POLL);
      expect(idx.isReady()).toBe(false);
    });

    it('isReady() returns true after init', async () => {
      idx = new FileIndex(workspace, NO_POLL);
      await idx.init();
      expect(idx.isReady()).toBe(true);
    });

    it('indexes files created before init', async () => {
      await writeFile(join(workspace, 'hello.ts'), '');
      await writeFile(join(workspace, 'world.md'), '');

      idx = new FileIndex(workspace, NO_POLL);
      await idx.init();

      expect(idx.size()).toBe(2);
    });

    it('indexes nested files and folders', async () => {
      await mkdir(join(workspace, 'src', 'utils'), { recursive: true });
      await writeFile(join(workspace, 'src', 'utils', 'helper.ts'), '');
      await writeFile(join(workspace, 'src', 'index.ts'), '');

      idx = new FileIndex(workspace, NO_POLL);
      await idx.init();

      expect(idx.size()).toBe(4);
    });

    it('records folder entries with type "folder"', async () => {
      await mkdir(join(workspace, 'lib'), { recursive: true });

      idx = new FileIndex(workspace, NO_POLL);
      await idx.init();

      const results = idx.search('lib');
      const lib = results.find((e) => e.name === 'lib');
      expect(lib).toBeDefined();
      expect(lib!.type).toBe('folder');
    });

    it('records file entries with type "file"', async () => {
      await writeFile(join(workspace, 'app.ts'), '');

      idx = new FileIndex(workspace, NO_POLL);
      await idx.init();

      const results = idx.search('app.ts');
      expect(results[0].type).toBe('file');
    });

    it('does not crash on empty workspace', async () => {
      idx = new FileIndex(workspace, NO_POLL);
      await idx.init();
      expect(idx.size()).toBe(0);
    });
  });

  describe('search', () => {
    beforeEach(async () => {
      await mkdir(join(workspace, 'src', 'components'), { recursive: true });
      await mkdir(join(workspace, 'src', 'utils'), { recursive: true });
      await writeFile(join(workspace, 'src', 'index.ts'), '');
      await writeFile(join(workspace, 'src', 'components', 'Button.tsx'), '');
      await writeFile(join(workspace, 'src', 'utils', 'format.ts'), '');
      await writeFile(join(workspace, 'README.md'), '');
    });

    it('returns empty array for empty cache', () => {
      idx = new FileIndex(workspace, NO_POLL);
      expect(idx.search('foo')).toEqual([]);
    });

    it('finds entries by exact name', async () => {
      idx = new FileIndex(workspace, NO_POLL);
      await idx.init();

      const results = idx.search('Button.tsx');
      expect(results.some((e) => e.name === 'Button.tsx')).toBe(true);
    });

    it('finds entries case-insensitively', async () => {
      idx = new FileIndex(workspace, NO_POLL);
      await idx.init();

      const results = idx.search('button.tsx');
      expect(results.some((e) => e.name === 'Button.tsx')).toBe(true);
    });

    it('finds entries by partial name match', async () => {
      idx = new FileIndex(workspace, NO_POLL);
      await idx.init();

      const results = idx.search('format');
      expect(results.some((e) => e.name === 'format.ts')).toBe(true);
    });

    it('finds entries by path segment', async () => {
      idx = new FileIndex(workspace, NO_POLL);
      await idx.init();

      const results = idx.search('components');
      expect(results.some((e) => e.path.includes('components'))).toBe(true);
    });

    it('returns results within limit', async () => {
      for (let i = 0; i < 30; i++) {
        await writeFile(join(workspace, `file${i}.ts`), '');
      }

      idx = new FileIndex(workspace, NO_POLL);
      await idx.init();

      const results = idx.search('file', 10);
      expect(results.length).toBeLessThanOrEqual(10);
    });

    it('defaults to limit 50', async () => {
      for (let i = 0; i < 60; i++) {
        await writeFile(join(workspace, `ts${i}.ts`), '');
      }

      idx = new FileIndex(workspace, NO_POLL);
      await idx.init();

      const results = idx.search('ts');
      expect(results.length).toBeLessThanOrEqual(50);
    });

    it('returns all entries for empty query (up to limit)', async () => {
      idx = new FileIndex(workspace, NO_POLL);
      await idx.init();

      const results = idx.search('');
      expect(results.length).toBeGreaterThan(0);
    });

    it('scores exact name matches higher than partial matches', async () => {
      await writeFile(join(workspace, 'format.ts'), '');
      await writeFile(join(workspace, 'formatter.ts'), '');

      idx = new FileIndex(workspace, NO_POLL);
      await idx.init();

      const results = idx.search('format.ts');
      expect(results[0].name).toBe('format.ts');
    });

    it('scores name-prefix matches higher than contains matches', async () => {
      await writeFile(join(workspace, 'index.ts'), '');
      await writeFile(join(workspace, 'main-index.ts'), '');

      idx = new FileIndex(workspace, NO_POLL);
      await idx.init();

      const results = idx.search('index');
      const indexPos = results.findIndex((e) => e.name === 'index.ts');
      const mainIndexPos = results.findIndex((e) => e.name === 'main-index.ts');
      expect(indexPos).toBeLessThan(mainIndexPos);
    });

    it('returns no results when query has no match', async () => {
      idx = new FileIndex(workspace, NO_POLL);
      await idx.init();

      const results = idx.search('zzznomatch999');
      expect(results.length).toBe(0);
    });
  });

  describe('invalidate', () => {
    it('removes a single entry from the cache', async () => {
      await writeFile(join(workspace, 'foo.ts'), '');
      await writeFile(join(workspace, 'bar.ts'), '');

      idx = new FileIndex(workspace, NO_POLL);
      await idx.init();
      expect(idx.size()).toBe(2);

      idx.invalidate('foo.ts');
      expect(idx.size()).toBe(1);
      expect(idx.search('foo.ts')).toEqual([]);
    });

    it('is a no-op for non-existent paths', async () => {
      await writeFile(join(workspace, 'file.ts'), '');

      idx = new FileIndex(workspace, NO_POLL);
      await idx.init();

      expect(() => idx.invalidate('nonexistent.ts')).not.toThrow();
      expect(idx.size()).toBe(1);
    });
  });

  describe('invalidateAll', () => {
    it('clears the entire cache', async () => {
      await writeFile(join(workspace, 'a.ts'), '');
      await writeFile(join(workspace, 'b.ts'), '');

      idx = new FileIndex(workspace, NO_POLL);
      await idx.init();
      expect(idx.size()).toBe(2);

      idx.invalidateAll();
      expect(idx.size()).toBe(0);
    });
  });

  describe('.gitignore filtering', () => {
    it('ignores .git directory', async () => {
      await mkdir(join(workspace, '.git'), { recursive: true });
      await writeFile(join(workspace, '.git', 'HEAD'), 'ref: refs/heads/main');

      idx = new FileIndex(workspace, NO_POLL);
      await idx.init();

      expect(idx.search('.git')).toEqual([]);
    });

    it('ignores node_modules directory', async () => {
      await mkdir(join(workspace, 'node_modules', 'lodash'), { recursive: true });
      await writeFile(join(workspace, 'node_modules', 'lodash', 'index.js'), '');

      idx = new FileIndex(workspace, NO_POLL);
      await idx.init();

      expect(idx.search('lodash')).toEqual([]);
      expect(idx.search('node_modules')).toEqual([]);
    });

    it('ignores .DS_Store files', async () => {
      await writeFile(join(workspace, '.DS_Store'), '');

      idx = new FileIndex(workspace, NO_POLL);
      await idx.init();

      expect(idx.search('.DS_Store')).toEqual([]);
      expect(idx.size()).toBe(0);
    });

    it('respects .gitignore wildcard patterns', async () => {
      await writeFile(join(workspace, '.gitignore'), '*.log\ndist/\n');
      await mkdir(join(workspace, 'dist'), { recursive: true });
      await writeFile(join(workspace, 'dist', 'bundle.js'), '');
      await writeFile(join(workspace, 'server.log'), '');
      await writeFile(join(workspace, 'app.ts'), '');

      idx = new FileIndex(workspace, NO_POLL);
      await idx.init();

      expect(idx.search('server.log')).toEqual([]);
      expect(idx.search('bundle.js')).toEqual([]);
      expect(idx.search('app.ts').length).toBeGreaterThan(0);
    });

    it('respects .gitignore negation patterns', async () => {
      await writeFile(join(workspace, '.gitignore'), '*.log\n!important.log\n');
      await writeFile(join(workspace, 'debug.log'), '');
      await writeFile(join(workspace, 'important.log'), '');

      idx = new FileIndex(workspace, NO_POLL);
      await idx.init();

      expect(idx.search('debug.log')).toEqual([]);
      expect(idx.search('important.log').length).toBeGreaterThan(0);
    });

    it('ignores gitignore comment lines and blank lines', async () => {
      await writeFile(
        join(workspace, '.gitignore'),
        '# This is a comment\n\n*.tmp\n\n# Another comment\n'
      );
      await writeFile(join(workspace, 'file.tmp'), '');
      await writeFile(join(workspace, 'keep.ts'), '');

      idx = new FileIndex(workspace, NO_POLL);
      await idx.init();

      expect(idx.search('file.tmp')).toEqual([]);
      expect(idx.search('keep.ts').length).toBeGreaterThan(0);
    });

    it('respects ** double-star pattern: build/**', async () => {
      await writeFile(join(workspace, '.gitignore'), 'build/**\n');
      await mkdir(join(workspace, 'build', 'assets'), { recursive: true });
      await writeFile(join(workspace, 'build', 'assets', 'app.js'), '');
      await writeFile(join(workspace, 'build', 'index.html'), '');
      await mkdir(join(workspace, 'src'), { recursive: true });
      await writeFile(join(workspace, 'src', 'main.ts'), '');

      idx = new FileIndex(workspace, NO_POLL);
      await idx.init();

      expect(idx.search('app.js')).toEqual([]);
      expect(idx.search('index.html')).toEqual([]);
    });

    it('respects **/prefix double-star pattern at root depth', async () => {
      await writeFile(join(workspace, '.gitignore'), '**/tests\n');
      await mkdir(join(workspace, 'tests'), { recursive: true });
      await writeFile(join(workspace, 'tests', 'foo.spec.ts'), '');
      await mkdir(join(workspace, 'src', 'tests'), { recursive: true });
      await writeFile(join(workspace, 'src', 'tests', 'bar.spec.ts'), '');
      await writeFile(join(workspace, 'src', 'app.ts'), '');

      idx = new FileIndex(workspace, NO_POLL);
      await idx.init();

      expect(idx.search('foo.spec.ts')).toEqual([]);
      expect(idx.search('bar.spec.ts')).toEqual([]);
      expect(idx.search('app.ts').length).toBeGreaterThan(0);
    });

    it('respects **/prefix double-star pattern at nested depths', async () => {
      await writeFile(join(workspace, '.gitignore'), '**/coverage\n');
      await mkdir(join(workspace, 'packages', 'web', 'coverage'), { recursive: true });
      await writeFile(join(workspace, 'packages', 'web', 'coverage', 'lcov.info'), '');
      await writeFile(join(workspace, 'packages', 'web', 'index.ts'), '');

      idx = new FileIndex(workspace, NO_POLL);
      await idx.init();

      expect(idx.search('lcov.info')).toEqual([]);
      expect(idx.search('index.ts').length).toBeGreaterThan(0);
    });

    it('respects ? single-character wildcard patterns', async () => {
      await writeFile(join(workspace, '.gitignore'), 'file?.ts\n');
      await writeFile(join(workspace, 'file1.ts'), '');
      await writeFile(join(workspace, 'file2.ts'), '');
      await writeFile(join(workspace, 'fileAB.ts'), '');
      await writeFile(join(workspace, 'keep.ts'), '');

      idx = new FileIndex(workspace, NO_POLL);
      await idx.init();

      expect(idx.search('file1.ts')).toEqual([]);
      expect(idx.search('file2.ts')).toEqual([]);
      expect(idx.search('fileAB.ts').length).toBeGreaterThan(0);
      expect(idx.search('keep.ts').length).toBeGreaterThan(0);
    });

    it('anchors a leading slash to the workspace root', async () => {
      await writeFile(join(workspace, '.gitignore'), '/dist/\n');
      await mkdir(join(workspace, 'dist'), { recursive: true });
      await writeFile(join(workspace, 'dist', 'bundle.js'), '');
      await mkdir(join(workspace, 'src', 'dist'), { recursive: true });
      await writeFile(join(workspace, 'src', 'dist', 'vendored.js'), '');

      idx = new FileIndex(workspace, NO_POLL);
      await idx.init();

      expect(idx.search('bundle.js')).toEqual([]);
      expect(idx.search('vendored.js').length).toBeGreaterThan(0);
    });

    it('treats square brackets as character classes', async () => {
      await writeFile(join(workspace, '.gitignore'), '[ab].tmp\n');
      await writeFile(join(workspace, 'a.tmp'), '');
      await writeFile(join(workspace, 'b.tmp'), '');
      await writeFile(join(workspace, 'c.tmp'), '');
      await writeFile(join(workspace, 'ab.tmp'), '');

      idx = new FileIndex(workspace, NO_POLL);
      await idx.init();

      const paths = indexedPaths(idx);
      expect(paths).not.toContain('a.tmp');
      expect(paths).not.toContain('b.tmp');
      expect(paths).toContain('c.tmp');
      expect(paths).toContain('ab.tmp');
    });

    it('treats an escaped dash in a character class as a literal', async () => {
      await writeFile(join(workspace, '.gitignore'), '[a\\-z].tmp\n');
      await writeFile(join(workspace, 'a.tmp'), '');
      await writeFile(join(workspace, '-.tmp'), '');
      await writeFile(join(workspace, 'z.tmp'), '');
      await writeFile(join(workspace, 'm.tmp'), '');

      idx = new FileIndex(workspace, NO_POLL);
      await idx.init();

      const paths = indexedPaths(idx);
      expect(paths).not.toContain('a.tmp');
      expect(paths).not.toContain('-.tmp');
      expect(paths).not.toContain('z.tmp');
      expect(paths).toContain('m.tmp');
    });

    it('treats an escaped closing bracket in a character class as a literal', async () => {
      await writeFile(join(workspace, '.gitignore'), '[a\\]b].tmp\n');
      await writeFile(join(workspace, 'a.tmp'), '');
      await writeFile(join(workspace, 'b.tmp'), '');
      await writeFile(join(workspace, 'x.tmp'), '');

      idx = new FileIndex(workspace, NO_POLL);
      await idx.init();

      const paths = indexedPaths(idx);
      expect(paths).not.toContain('a.tmp');
      expect(paths).not.toContain('b.tmp');
      expect(paths).toContain('x.tmp');
    });

    it('supports negated character classes', async () => {
      await writeFile(join(workspace, '.gitignore'), '[!a].tmp\n');
      await writeFile(join(workspace, 'a.tmp'), '');
      await writeFile(join(workspace, 'b.tmp'), '');

      idx = new FileIndex(workspace, NO_POLL);
      await idx.init();

      expect(idx.search('a.tmp').length).toBeGreaterThan(0);
      expect(idx.search('b.tmp')).toEqual([]);
    });

    it('treats a bracket without a closing bracket as a literal', async () => {
      await writeFile(join(workspace, '.gitignore'), 'a[b\n');
      await writeFile(join(workspace, 'a[b'), '');
      await writeFile(join(workspace, 'ab'), '');

      idx = new FileIndex(workspace, NO_POLL);
      await idx.init();

      expect(idx.search('a[b')).toEqual([]);
      expect(idx.search('ab').length).toBeGreaterThan(0);
    });

    it('matches patterns case-insensitively on a case-insensitive filesystem', async () => {
      await writeFile(join(workspace, '.gitignore'), 'Build/\n');
      await mkdir(join(workspace, 'build'), { recursive: true });
      await writeFile(join(workspace, 'build', 'out.js'), '');

      idx = new FileIndex(workspace, NO_POLL, false);
      await idx.init();

      expect(idx.search('out.js')).toEqual([]);
    });

    it('matches patterns case-sensitively on a case-sensitive filesystem', async () => {
      await writeFile(join(workspace, '.gitignore'), 'Build/\n');
      await mkdir(join(workspace, 'build'), { recursive: true });
      await writeFile(join(workspace, 'build', 'out.js'), '');

      idx = new FileIndex(workspace, NO_POLL, true);
      await idx.init();

      expect(idx.search('out.js').length).toBeGreaterThan(0);
    });

    it('skips only the malformed pattern, keeping the rest of the file', async () => {
      await writeFile(join(workspace, '.gitignore'), '[z-a]\n*.log\n');
      await writeFile(join(workspace, 'drop.log'), '');
      await writeFile(join(workspace, 'keep.ts'), '');

      idx = new FileIndex(workspace, NO_POLL);
      await idx.init();

      expect(idx.search('drop.log')).toEqual([]);
      expect(idx.search('keep.ts').length).toBeGreaterThan(0);
    });

    it('keeps a non-adjacent ** within a single path segment', async () => {
      await writeFile(join(workspace, '.gitignore'), 'foo**bar\n');
      await writeFile(join(workspace, 'foobar'), '');
      await writeFile(join(workspace, 'foo1zzbar'), '');
      await mkdir(join(workspace, 'foo', 'x'), { recursive: true });
      await writeFile(join(workspace, 'foo', 'x', 'bar'), '');

      idx = new FileIndex(workspace, NO_POLL);
      await idx.init();

      const paths = indexedPaths(idx);
      expect(paths).not.toContain('foobar');
      expect(paths).not.toContain('foo1zzbar');
      expect(paths).toContain('foo/x/bar');
    });

    it('does not let a negated character class match the path separator', async () => {
      await writeFile(join(workspace, '.gitignore'), 'a[!b]c\n');
      await writeFile(join(workspace, 'axc'), '');
      await mkdir(join(workspace, 'a'), { recursive: true });
      await writeFile(join(workspace, 'a', 'c'), '');

      idx = new FileIndex(workspace, NO_POLL);
      await idx.init();

      const paths = indexedPaths(idx);
      expect(paths).not.toContain('axc');
      expect(paths).toContain('a/c');
    });

    it('honors backslash escapes for leading ! and #', async () => {
      await writeFile(join(workspace, '.gitignore'), '\\!keep\n\\#hash.ts\n');
      await writeFile(join(workspace, '!keep'), '');
      await writeFile(join(workspace, '#hash.ts'), '');
      await writeFile(join(workspace, 'other.ts'), '');

      idx = new FileIndex(workspace, NO_POLL);
      await idx.init();

      const paths = indexedPaths(idx);
      expect(paths).not.toContain('!keep');
      expect(paths).not.toContain('#hash.ts');
      expect(paths).toContain('other.ts');
    });

    it('honors backslash-escaped wildcards as literals', async () => {
      await writeFile(join(workspace, '.gitignore'), 'lit\\*eral\n');
      await writeFile(join(workspace, 'lit*eral'), '');
      await writeFile(join(workspace, 'litXeral'), '');

      idx = new FileIndex(workspace, NO_POLL);
      await idx.init();

      const paths = indexedPaths(idx);
      expect(paths).not.toContain('lit*eral');
      expect(paths).toContain('litXeral');
    });

    it('strips a UTF-8 BOM before the first pattern', async () => {
      await writeFile(join(workspace, '.gitignore'), '\uFEFF*.log\n');
      await writeFile(join(workspace, 'drop.log'), '');
      await writeFile(join(workspace, 'keep.ts'), '');

      idx = new FileIndex(workspace, NO_POLL);
      await idx.init();

      const paths = indexedPaths(idx);
      expect(paths).not.toContain('drop.log');
      expect(paths).toContain('keep.ts');
    });

    it('does not let a dir-only negation un-ignore a file inside it', async () => {
      await writeFile(join(workspace, '.gitignore'), '*.log\n!logs/\n');
      await mkdir(join(workspace, 'logs'), { recursive: true });
      await writeFile(join(workspace, 'logs', 'a.log'), '');

      idx = new FileIndex(workspace, NO_POLL);
      await idx.init();

      expect(indexedPaths(idx)).not.toContain('logs/a.log');
    });

    it('keeps files inside a directory ignored by a directory rule', async () => {
      await writeFile(join(workspace, '.gitignore'), 'build/\n!build/keep.js\n');
      await mkdir(join(workspace, 'build'), { recursive: true });
      await writeFile(join(workspace, 'build', 'keep.js'), '');
      await writeFile(join(workspace, 'build', 'drop.js'), '');

      idx = new FileIndex(workspace, NO_POLL);
      await idx.init();

      const paths = indexedPaths(idx);
      expect(paths).not.toContain('build/keep.js');
      expect(paths).not.toContain('build/drop.js');
    });

    it('anchors a slash-containing pattern to the workspace root', async () => {
      await writeFile(join(workspace, '.gitignore'), 'logs/debug.log\n');
      await mkdir(join(workspace, 'logs'), { recursive: true });
      await mkdir(join(workspace, 'src', 'logs'), { recursive: true });
      await writeFile(join(workspace, 'logs', 'debug.log'), '');
      await writeFile(join(workspace, 'src', 'logs', 'debug.log'), '');

      idx = new FileIndex(workspace, NO_POLL);
      await idx.init();

      const paths = indexedPaths(idx);
      expect(paths).not.toContain('logs/debug.log');
      expect(paths).toContain('src/logs/debug.log');
    });

    it('matches slash-less patterns at any depth', async () => {
      await writeFile(join(workspace, '.gitignore'), '*.log\n');
      await mkdir(join(workspace, 'logs'), { recursive: true });
      await mkdir(join(workspace, 'src', 'logs'), { recursive: true });
      await writeFile(join(workspace, 'root.log'), '');
      await writeFile(join(workspace, 'logs', 'a.log'), '');
      await writeFile(join(workspace, 'src', 'logs', 'b.log'), '');
      await writeFile(join(workspace, 'keep.ts'), '');

      idx = new FileIndex(workspace, NO_POLL);
      await idx.init();

      expect(idx.search('root.log')).toEqual([]);
      expect(idx.search('a.log')).toEqual([]);
      expect(idx.search('b.log')).toEqual([]);
      expect(idx.search('keep.ts').length).toBeGreaterThan(0);
    });

    it('restricts directory-only patterns to directories', async () => {
      await writeFile(join(workspace, '.gitignore'), 'dist/\n');
      await mkdir(join(workspace, 'dist'), { recursive: true });
      await writeFile(join(workspace, 'dist', 'bundle.js'), '');
      await writeFile(join(workspace, 'distfile'), '');

      idx = new FileIndex(workspace, NO_POLL);
      await idx.init();

      expect(idx.search('bundle.js')).toEqual([]);
      expect(idx.search('distfile').length).toBeGreaterThan(0);
    });
  });

  describe('nested .gitignore files', () => {
    it('applies a nested .gitignore to its own directory', async () => {
      await writeFile(join(workspace, '.gitignore'), '\n');
      await mkdir(join(workspace, 'sub'), { recursive: true });
      await writeFile(join(workspace, 'sub', '.gitignore'), '*.log\n');
      await writeFile(join(workspace, 'sub', 'drop.log'), '');
      await writeFile(join(workspace, 'sub', 'keep.ts'), '');
      await writeFile(join(workspace, 'root.log'), '');

      idx = new FileIndex(workspace, NO_POLL);
      await idx.init();

      expect(idx.search('drop.log')).toEqual([]);
      expect(idx.search('keep.ts').length).toBeGreaterThan(0);
      expect(idx.search('root.log').length).toBeGreaterThan(0);
    });

    it('scopes a nested anchored pattern to that directory', async () => {
      await writeFile(join(workspace, '.gitignore'), '\n');
      await mkdir(join(workspace, 'sub'), { recursive: true });
      await writeFile(join(workspace, 'sub', '.gitignore'), '/drop/\n');
      await mkdir(join(workspace, 'sub', 'drop'), { recursive: true });
      await writeFile(join(workspace, 'sub', 'drop', 'x.js'), '');
      await mkdir(join(workspace, 'drop'), { recursive: true });
      await writeFile(join(workspace, 'drop', 'y.js'), '');

      idx = new FileIndex(workspace, NO_POLL);
      await idx.init();

      expect(idx.search('x.js')).toEqual([]);
      expect(idx.search('y.js').length).toBeGreaterThan(0);
    });

    it('lets a nested negation override a parent ignore', async () => {
      await writeFile(join(workspace, '.gitignore'), '*.log\n');
      await mkdir(join(workspace, 'sub'), { recursive: true });
      await writeFile(join(workspace, 'sub', '.gitignore'), '!keep.log\n');
      await writeFile(join(workspace, 'sub', 'keep.log'), '');
      await writeFile(join(workspace, 'sub', 'drop.log'), '');

      idx = new FileIndex(workspace, NO_POLL);
      await idx.init();

      expect(idx.search('keep.log').length).toBeGreaterThan(0);
      expect(idx.search('drop.log')).toEqual([]);
    });

    it('does not descend into an ignored parent directory', async () => {
      await writeFile(join(workspace, '.gitignore'), 'node_modules/\n');
      await mkdir(join(workspace, 'node_modules', 'pkg'), { recursive: true });
      await writeFile(join(workspace, 'node_modules', '.gitignore'), '!important.js\n');
      await writeFile(join(workspace, 'node_modules', 'pkg', 'index.js'), '');

      idx = new FileIndex(workspace, NO_POLL);
      await idx.init();

      expect(idx.search('index.js')).toEqual([]);
    });
  });

  describe('ignore file refresh semantics', () => {
    it('applies a .gitignore edited after init on refresh', async () => {
      await writeFile(join(workspace, '.gitignore'), '');
      await writeFile(join(workspace, 'keep.ts'), '');

      idx = new FileIndex(workspace, NO_POLL);
      await idx.init();
      expect(idx.search('keep.ts').length).toBeGreaterThan(0);

      await writeFile(join(workspace, '.gitignore'), '*.ts\n');
      await idx.refresh();

      expect(idx.search('keep.ts')).toEqual([]);
    });

    it('drops a .gitignore removed after init on refresh', async () => {
      await writeFile(join(workspace, '.gitignore'), '*.ts\n');
      await writeFile(join(workspace, 'keep.ts'), '');

      idx = new FileIndex(workspace, NO_POLL);
      await idx.init();
      expect(idx.search('keep.ts')).toEqual([]);

      await rm(join(workspace, '.gitignore'));
      await idx.refresh();

      expect(idx.search('keep.ts').length).toBeGreaterThan(0);
    });

    it('picks up a nested .gitignore created after init on refresh', async () => {
      await writeFile(join(workspace, '.gitignore'), '');
      await mkdir(join(workspace, 'sub'), { recursive: true });
      await writeFile(join(workspace, 'sub', 'drop.log'), '');

      idx = new FileIndex(workspace, NO_POLL);
      await idx.init();
      expect(idx.search('drop.log').length).toBeGreaterThan(0);

      await writeFile(join(workspace, 'sub', '.gitignore'), '*.log\n');
      await idx.refresh();

      expect(idx.search('drop.log')).toEqual([]);
    });
  });

  describe('setIgnorePatterns', () => {
    it('applies extra patterns on subsequent init', async () => {
      await writeFile(join(workspace, 'secret.key'), '');
      await writeFile(join(workspace, 'app.ts'), '');

      idx = new FileIndex(workspace, NO_POLL);
      idx.setIgnorePatterns(['*.key']);
      await idx.init();

      expect(idx.search('secret.key')).toEqual([]);
      expect(idx.search('app.ts').length).toBeGreaterThan(0);
    });

    it('immediately re-filters cache when called after init', async () => {
      await writeFile(join(workspace, 'secret.key'), '');
      await writeFile(join(workspace, 'app.ts'), '');

      idx = new FileIndex(workspace, NO_POLL);
      await idx.init();

      expect(idx.search('secret.key').length).toBeGreaterThan(0);
      expect(idx.search('app.ts').length).toBeGreaterThan(0);

      idx.setIgnorePatterns(['*.key']);

      expect(idx.search('secret.key')).toEqual([]);
      expect(idx.search('app.ts').length).toBeGreaterThan(0);
    });

    it('refresh also removes entries matching patterns set after init', async () => {
      await writeFile(join(workspace, 'secret.key'), '');
      await writeFile(join(workspace, 'app.ts'), '');

      idx = new FileIndex(workspace, NO_POLL);
      await idx.init();

      idx.setIgnorePatterns(['*.key']);

      await (idx as unknown as { runRefresh(): Promise<void> }).runRefresh();

      expect(idx.search('secret.key')).toEqual([]);
    });
  });

  describe('path traversal prevention', () => {
    it('does not index paths outside the workspace', async () => {
      await writeFile(join(workspace, 'safe.ts'), '');

      idx = new FileIndex(workspace, NO_POLL);
      await idx.init();

      for (const entry of idx.search('')) {
        expect(entry.path.startsWith('..')).toBe(false);
        expect(entry.path.startsWith('/')).toBe(false);
      }
    });

    it('search results never expose absolute paths', async () => {
      await writeFile(join(workspace, 'file.ts'), '');

      idx = new FileIndex(workspace, NO_POLL);
      await idx.init();

      const results = idx.search('file.ts');
      expect(results.length).toBeGreaterThan(0);
      results.forEach((r) => {
        expect(r.path.startsWith('/')).toBe(false);
      });
    });
  });

  describe('polling refresh', () => {
    it('picks up new files on next refresh', async () => {
      idx = new FileIndex(workspace, NO_POLL);
      await idx.init();
      expect(idx.size()).toBe(0);

      await writeFile(join(workspace, 'new.ts'), '');

      await (idx as unknown as { runRefresh(): Promise<void> }).runRefresh();

      expect(idx.size()).toBe(1);
      expect(idx.search('new.ts').length).toBeGreaterThan(0);
    });

    it('removes deleted files on next refresh', async () => {
      await writeFile(join(workspace, 'delete-me.ts'), '');

      idx = new FileIndex(workspace, NO_POLL);
      await idx.init();
      expect(idx.size()).toBe(1);

      await rm(join(workspace, 'delete-me.ts'));

      await (idx as unknown as { runRefresh(): Promise<void> }).runRefresh();

      expect(idx.size()).toBe(0);
    });

    it('dispose() stops the polling timer', () => {
      idx = new FileIndex(workspace, 100);
      idx.dispose();
      const internal = idx as unknown as { pollTimer: unknown };
      expect(internal.pollTimer).toBeNull();
    });
  });

  describe('edge cases', () => {
    it('handles files with spaces and special characters', async () => {
      await writeFile(join(workspace, 'my file.ts'), '');
      await writeFile(join(workspace, 'kebab-case.ts'), '');

      idx = new FileIndex(workspace, NO_POLL);
      await idx.init();

      expect(idx.search('my file.ts').length).toBeGreaterThan(0);
      expect(idx.search('kebab-case').length).toBeGreaterThan(0);
    });

    it('returns correct relative paths with forward slashes', async () => {
      await mkdir(join(workspace, 'a', 'b'), { recursive: true });
      await writeFile(join(workspace, 'a', 'b', 'deep.ts'), '');

      idx = new FileIndex(workspace, NO_POLL);
      await idx.init();

      const results = idx.search('deep.ts');
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].path).toContain('deep.ts');
    });

    it('handles deeply nested workspaces', async () => {
      const deep = join(workspace, 'a', 'b', 'c', 'd', 'e');
      await mkdir(deep, { recursive: true });
      await writeFile(join(deep, 'very-deep.ts'), '');

      idx = new FileIndex(workspace, NO_POLL);
      await idx.init();

      expect(idx.search('very-deep').length).toBeGreaterThan(0);
    });

    it('size() returns accurate count', async () => {
      for (let i = 0; i < 5; i++) {
        await writeFile(join(workspace, `file${i}.ts`), '');
      }

      idx = new FileIndex(workspace, NO_POLL);
      await idx.init();

      expect(idx.size()).toBe(5);
    });

    it('search is fast for large workspaces', async () => {
      for (let i = 0; i < 10; i++) {
        const dir = join(workspace, `pkg${i}`);
        await mkdir(dir, { recursive: true });
        for (let j = 0; j < 20; j++) {
          await writeFile(join(dir, `file${j}.ts`), '');
        }
      }

      idx = new FileIndex(workspace, NO_POLL);
      await idx.init();

      const start = Date.now();
      for (let i = 0; i < 100; i++) {
        idx.search(`file${i % 20}`);
      }
      const elapsed = Date.now() - start;

      expect(elapsed).toBeLessThan(1000);
    });

    it('indexes symlinked files', async () => {
      const { symlink } = await import('node:fs/promises');
      const target = join(workspace, 'real.ts');
      const link = join(workspace, 'linked.ts');
      await writeFile(target, '');
      await symlink(target, link);

      idx = new FileIndex(workspace, NO_POLL);
      await idx.init();

      const results = idx.search('linked.ts');
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].type).toBe('file');
    });

    it('indexes symlinked directories as folders without recursing', async () => {
      const { symlink } = await import('node:fs/promises');
      const targetDir = join(workspace, 'real-dir');
      await mkdir(targetDir, { recursive: true });
      await writeFile(join(targetDir, 'inside.ts'), '');

      const linkDir = join(workspace, 'linked-dir');
      await symlink(targetDir, linkDir);

      idx = new FileIndex(workspace, NO_POLL);
      await idx.init();

      const results = idx.search('linked-dir');
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].type).toBe('folder');
    });
  });
});
