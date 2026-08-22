import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stripComments } from './strip-comments.ts';

const scriptPath = join(import.meta.dir, 'strip-comments.ts');
const repoRoot = join(import.meta.dir, '..');

describe('strip-comments', () => {
  it('does not treat flags after --files as paths', () => {
    const result = spawnSync('bun', [scriptPath, '--files', scriptPath, '--check'], {
      encoding: 'utf8',
      env: process.env,
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toBe('files with comments: 0, comments removed: 0\n');
  });

  it('strips untracked sources in strip mode but checks only tracked files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'strip-comments-'));
    try {
      spawnSync('git', ['init'], { cwd: dir });
      writeFileSync(join(dir, 'tracked.ts'), 'const a = 1; // gone\n');
      spawnSync('git', ['add', 'tracked.ts'], { cwd: dir });
      writeFileSync(join(dir, 'fresh.ts'), 'const b = 2; // gone\n');

      const strip = spawnSync('bun', [scriptPath], { cwd: dir, encoding: 'utf8' });
      expect(strip.status).toBe(0);
      expect(readFileSync(join(dir, 'tracked.ts'), 'utf8')).toBe('const a = 1;\n');
      expect(readFileSync(join(dir, 'fresh.ts'), 'utf8')).toBe('const b = 2;\n');

      writeFileSync(join(dir, 'fresh.ts'), 'const b = 2; // back\n');
      const check = spawnSync('bun', [scriptPath, '--check'], { cwd: dir, encoding: 'utf8' });
      expect(check.status).toBe(0);

      rmSync(join(dir, 'tracked.ts'));
      const afterDelete = spawnSync('bun', [scriptPath], { cwd: dir, encoding: 'utf8' });
      expect(afterDelete.status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('strips a comment that is the sole content of an arrow function block', () => {
    const source = 'promise.then(() => {\n  /* dead-letter settlement is best-effort */\n});\n';
    expect(stripComments(source, 'a.ts', false)).toBe('promise.then(() => {\n});\n');
  });

  it('strips a comment that is the sole content of a catch block', () => {
    const source = 'try {\n  x();\n} catch {\n  /* best-effort on shutdown */\n}\n';
    expect(stripComments(source, 'a.ts', false)).toBe('try {\n  x();\n} catch {\n}\n');
  });

  it('strips comments in empty arrays, objects, parenthesized expressions, and type literals', () => {
    const source = [
      'const a = [/* empty array */];',
      'const b = {/* empty object */};',
      'const c = (/* empty paren */);',
      'type D = {/* empty type */};',
      '',
    ].join('\n');
    expect(stripComments(source, 'a.ts', false)).toBe(
      'const a = [];\nconst b = {};\nconst c = ();\ntype D = {};\n'
    );
  });

  it('strips a comment between an opening delimiter and its first token on the same line', () => {
    const source = 'f(/* why */ a);\n';
    expect(stripComments(source, 'a.ts', false)).toBe('f(a);\n');
  });

  it('keeps exempt directives inside empty containers', () => {
    const source =
      'const f = () => {\n  /* biome-ignore lint/suspicious/noEmptyBlock: placeholder */\n};\n';
    expect(stripComments(source, 'a.ts', false)).toBe(source);
  });

  it('keeps eslint disable and enable directives', () => {
    const source = [
      '// eslint-disable-next-line react-hooks/exhaustive-deps -- explanation',
      'call();',
      '/* eslint-disable no-console */',
      'console.log();',
      '/* eslint-enable no-console */',
      '',
    ].join('\n');
    expect(stripComments(source, 'a.tsx', false)).toBe(source);
  });

  it('strips comments that merely mention eslint', () => {
    const source = 'call(); // explain this eslint behavior\n';
    expect(stripComments(source, 'a.ts', false)).toBe('call();\n');
  });

  it('keeps every functional directive form at the start of the comment', () => {
    const source = [
      '// @ts-expect-error - checking for Optional symbol',
      'const a = x;',
      '// @ts-nocheck',
      '// biome-ignore lint/suspicious/noEmptyBlock: placeholder',
      '// oxlint-disable-next-line no-explicit-any',
      '/** @public - Preact signal accessed via .value in components */',
      '/**\n * @public Exported for testing purposes\n */',
      'const b = 1; /* v8 ignore next 3 */',
      '// knip-ignore-next-line',
      '',
    ].join('\n');
    expect(stripComments(source, 'a.tsx', false)).toBe(source);
  });

  it('strips prose that merely mentions a directive keyword', () => {
    const source = [
      'call(); // explain biome-ignore behavior',
      'call(); // mention @ts-ignore here',
      'call(); // discuss oxlint-disable choices',
      'call(); // note the @public marker',
      'call(); // why v8 ignore exists',
      'call(); // what knip-ignore does',
      '/**\n * Exports marked with @public JSDoc tag are reported.\n */',
      '',
    ].join('\n');
    expect(stripComments(source, 'a.ts', false)).toBe('call();\n'.repeat(6));
  });

  it('does not treat comment markers inside string and template literals as comments', () => {
    const source = 'const a = "/* not a comment */";\nconst b = `// not a comment`;\n';
    expect(stripComments(source, 'a.ts', false)).toBe(source);
  });

  it('does not treat comment markers inside JSX text as comments', () => {
    const source = 'export const C = () => (<p>see https://example.com // not a comment</p>);\n';
    expect(stripComments(source, 'a.tsx', true)).toBe(source);
  });

  it('inserts a space when an inline comment is the only separator between words', () => {
    const source = 'const result = typeof/* note */value;\n';
    expect(stripComments(source, 'a.ts', false)).toBe('const result = typeof value;\n');
  });

  it('keeps adjacent words separated across consecutive inline comments', () => {
    const source = 'let/* decl */x = 1;\nasync/* fn */function f() {}\n';
    expect(stripComments(source, 'a.ts', false)).toBe('let x = 1;\nasync function f() {}\n');
  });

  it('does not insert a space when a neighbor is not an identifier character', () => {
    const source = 'f(/* why */ a);\nvalue./* member */prop;\n';
    expect(stripComments(source, 'a.ts', false)).toBe('f(a);\nvalue.prop;\n');
  });

  it('keeps a line terminator when a block comment spanning lines separates two words', () => {
    const source = 'function f() {\n  return/* note\n   */1;\n}\n';
    expect(stripComments(source, 'a.ts', false)).toBe('function f() {\n  return\n1;\n}\n');
  });

  it('keeps a plain space when the same comment stays on one line', () => {
    const source = 'function f() {\n  return/* note */1;\n}\n';
    expect(stripComments(source, 'a.ts', false)).toBe('function f() {\n  return 1;\n}\n');
  });

  it('preserves restricted-production ASI before punctuation after a multi-line comment', () => {
    const source = 'function f() {\n  return /* wrap\n     */(1);\n}\n';
    expect(stripComments(source, 'a.ts', false)).toBe('function f() {\n  return\n(1);\n}\n');
  });

  it('does not duplicate a newline for comments that already occupied whole lines', () => {
    const source = 'return\n/* note\n */\n(1);\n';
    expect(stripComments(source, 'a.ts', false)).toBe('return\n(1);\n');
  });

  it('leaves template literal contents untouched even when comments exist elsewhere', () => {
    const source = 'const t = `a   \n\n\nb`;\nconst u = 1; // note\n';
    expect(stripComments(source, 'a.ts', false)).toBe('const t = `a   \n\n\nb`;\nconst u = 1;\n');
  });

  it('cleans removal seams without touching pre-existing whitespace elsewhere', () => {
    const source = 'a();   \n\n\nb(); /* tail */\n';
    expect(stripComments(source, 'a.ts', false)).toBe('a();   \n\n\nb();\n');
  });

  it('separates a word from an escape-started identifier after a comment', () => {
    const source = 'const r = typeof/* note */\\u0076alue;\n';
    expect(stripComments(source, 'a.ts', false)).toBe('const r = typeof \\u0076alue;\n');
  });

  it('treats carriage return inside a removed comment as a line terminator', () => {
    const source = 'function f() {\n  return/* note\r   */1;\n}\n';
    expect(stripComments(source, 'a.ts', false)).toBe('function f() {\n  return\n1;\n}\n');
  });

  it('treats unicode line separators inside a removed comment as line terminators', () => {
    const source = 'function f() {\n  return/* note\u2028 */1;\n}\n';
    expect(stripComments(source, 'a.ts', false)).toBe('function f() {\n  return\n1;\n}\n');
  });

  it('does not insert separators between JSX text adjacent to a removed expression', () => {
    const source = 'export const C = () => (<p>Hello{/* x */}World</p>);\n';
    expect(stripComments(source, 'a.tsx', true)).toBe(
      'export const C = () => (<p>Hello{}World</p>);\n'
    );
  });

  it('separates adjacent punctuators that would combine into a longer operator', () => {
    const source = 'const y = +/* note */+x;\nconst z = -/* note */-x;\n';
    expect(stripComments(source, 'a.ts', false)).toBe('const y = + +x;\nconst z = - -x;\n');
  });

  it('keeps a regex literal separate from an assignment operator', () => {
    const source = 'const ok = /* pattern *//ABC/.test(s);\n';
    expect(stripComments(source, 'a.ts', false)).toBe('const ok = /ABC/.test(s);\n');
  });

  it('does not add separators between non-combining delimiters', () => {
    const source = 'const a = [/* empty */];\nconst b = f(/* args */);\n';
    expect(stripComments(source, 'a.ts', false)).toBe('const a = [];\nconst b = f();\n');
  });

  it('preserves restricted-production ASI before a postfix operator', () => {
    const source = 'x/* note\n */++\ny;\n';
    expect(stripComments(source, 'a.ts', false)).toBe('x\n++\ny;\n');
  });

  it('skips whitespace before a removed comment when preserving postfix ASI', () => {
    const source = 'x /* note\n */++\ny;\n';
    expect(stripComments(source, 'a.ts', false)).toBe('x\n++\ny;\n');
  });

  it('retains empty JSX expression containers so child structure survives', () => {
    const source = 'export const W = () => (<W>Hello{/* note */}World</W>);\n';
    expect(stripComments(source, 'a.tsx', true)).toBe(
      'export const W = () => (<W>Hello{}World</W>);\n'
    );
  });

  it('keeps exempt directives after CR-delimited line comments', () => {
    const source = '// prose\r// @ts-expect-error\rconst x = nope;\r';
    expect(stripComments(source, 'a.ts', false)).toBe('// @ts-expect-error\rconst x = nope;\r');
  });

  it('ends line comments at CR so following statements survive stripping', () => {
    const source = 'const a = 1; // note\rconst b = 2;\r';
    expect(stripComments(source, 'a.ts', false)).toBe('const a = 1;\rconst b = 2;\r');
  });
});

describe('zero-comments wiring', () => {
  it('runs the no-comments gate before test-quality in the check chain', async () => {
    const pkg = (await Bun.file(join(repoRoot, 'package.json')).json()) as {
      scripts: Record<string, string>;
    };
    const check = pkg.scripts.check ?? '';
    const noComments = check.indexOf('check:no-comments');
    const testQuality = check.indexOf('check:test-quality');
    expect(noComments).toBeGreaterThan(-1);
    expect(testQuality).toBeGreaterThan(-1);
    expect(noComments).toBeLessThan(testQuality);
  });

  it('strips comments before formatting in the make format target', async () => {
    const makefile = await Bun.file(join(repoRoot, 'Makefile')).text();
    const recipe = /^format:.*\n((?:\t[^\n]*\n)+)/m.exec(makefile)?.[1] ?? '';
    const strip = recipe.indexOf('strip-comments');
    const format = recipe.indexOf('bun run format');
    expect(strip).toBeGreaterThan(-1);
    expect(format).toBeGreaterThan(-1);
    expect(strip).toBeLessThan(format);
  });

  it('exposes a strip-comments script that strips instead of checking', async () => {
    const pkg = (await Bun.file(join(repoRoot, 'package.json')).json()) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts['strip-comments']).toBe('bun scripts/strip-comments.ts');
  });
});
