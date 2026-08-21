import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { stripComments } from './strip-comments.ts';

const scriptPath = join(import.meta.dir, 'strip-comments.ts');

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
});
