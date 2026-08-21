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

  it('does not treat comment markers inside string and template literals as comments', () => {
    const source = 'const a = "/* not a comment */";\nconst b = `// not a comment`;\n';
    expect(stripComments(source, 'a.ts', false)).toBe(source);
  });

  it('does not treat comment markers inside JSX text as comments', () => {
    const source = 'export const C = () => (<p>see https://example.com // not a comment</p>);\n';
    expect(stripComments(source, 'a.tsx', true)).toBe(source);
  });
});
