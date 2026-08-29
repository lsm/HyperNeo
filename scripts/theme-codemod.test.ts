import { describe, expect, it } from 'bun:test';
import {
  rewriteClassString,
  collectRewrites,
  applyRewrites,
  type ThemeMapping,
} from './codemod-theme.ts';
import { countRawPalette, areaOf } from './check-raw-palette.ts';

const mapping: ThemeMapping = {
  utilities: {
    'bg-dark-800': 'bg-surface-raised',
    'text-gray-400': 'text-fg-muted',
  },
  pairs: {
    'bg-amber-50|dark:bg-amber-900/10': 'bg-warning/10',
  },
};

describe('rewriteClassString', () => {
  it('rewrites exact utility matches', () => {
    const result = rewriteClassString('p-4 bg-dark-800 rounded', mapping);
    expect(result.text).toBe('p-4 bg-surface-raised rounded');
    expect(result.changes).toEqual(['bg-dark-800 -> bg-surface-raised']);
  });

  it('rewrites variant-prefixed utilities but skips the dark: variant', () => {
    const result = rewriteClassString('hover:bg-dark-800 dark:bg-dark-800', mapping);
    expect(result.text).toBe('hover:bg-surface-raised dark:bg-dark-800');
  });

  it('passes opacity suffixes through to the mapped token', () => {
    const result = rewriteClassString('bg-dark-800/60 hover:text-gray-400/60', mapping);
    expect(result.text).toBe('bg-surface-raised/60 hover:text-fg-muted/60');
  });

  it('does not stack a second suffix onto a suffixed mapping target', () => {
    const withSuffixed: ThemeMapping = {
      utilities: { 'bg-red-50': 'bg-danger/10' },
      pairs: {},
    };
    expect(rewriteClassString('bg-red-50/50', withSuffixed).text).toBe('bg-danger/10');
  });

  it('matches suffixed mapping entries under a variant prefix', () => {
    const withAlpha: ThemeMapping = {
      utilities: { 'bg-white/5': 'bg-fill-soft' },
      pairs: {},
    };
    expect(rewriteClassString('hover:bg-white/5', withAlpha).text).toBe('hover:bg-fill-soft');
  });

  it('collapses light/dark pairs into one semantic token', () => {
    const result = rewriteClassString('p-2 bg-amber-50 dark:bg-amber-900/10 text-sm', mapping);
    expect(result.text).toBe('p-2 bg-warning/10 text-sm');
    expect(result.changes).toEqual(['bg-amber-50|dark:bg-amber-900/10 -> bg-warning/10']);
  });

  it('collapses pairs regardless of token order', () => {
    const result = rewriteClassString('dark:bg-amber-900/10 bg-amber-50', mapping);
    expect(result.text).toBe('bg-warning/10');
  });

  it('drops dark: orphans once the light side is semantic', () => {
    const result = rewriteClassString('text-gray-400 dark:text-gray-500', mapping);
    expect(result.text).toBe('text-fg-muted');
  });

  it('keeps dark: tokens whose mapped target differs from the light side', () => {
    const toneShift: ThemeMapping = {
      utilities: { 'text-green-400': 'text-success-soft', 'text-red-400': 'text-danger-soft' },
      pairs: {},
    };
    expect(rewriteClassString('text-green-400 dark:text-red-400', toneShift).text).toBe(
      'text-success-soft dark:text-red-400'
    );
  });

  it('drops dark: overrides that map to the same target as the light side', () => {
    const sameTarget: ThemeMapping = {
      utilities: { 'text-gray-400': 'text-fg-muted', 'text-gray-500': 'text-fg-muted' },
      pairs: {},
    };
    expect(rewriteClassString('text-gray-400 dark:text-gray-500', sameTarget).text).toBe(
      'text-fg-muted'
    );
  });

  it('keeps dark: tokens when the light side is unmapped', () => {
    const result = rewriteClassString('bg-white dark:bg-gray-700', mapping);
    expect(result.text).toBe('bg-white dark:bg-gray-700');
    expect(result.changes).toEqual([]);
  });

  it('returns the original string when nothing maps', () => {
    const result = rewriteClassString('p-4  text-blue-500', mapping);
    expect(result.text).toBe('p-4  text-blue-500');
    expect(result.changes).toEqual([]);
  });
});

describe('collectRewrites/applyRewrites', () => {
  it('rewrites class attributes and cn() calls only', () => {
    const source = [
      "const label = 'bg-dark-800';",
      'export const A = () => <div class="bg-dark-800 text-gray-400" />;',
      "export const B = () => <div className={cn('p-2', 'bg-dark-800')} />;",
    ].join('\n');
    const { rewrites, changes } = collectRewrites(source, 'sample.tsx', mapping);
    const next = applyRewrites(source, rewrites);
    expect(changes.length).toBe(3);
    expect(next).toContain("const label = 'bg-dark-800';");
    expect(next).toContain('class="bg-surface-raised text-fg-muted"');
    expect(next).toContain("cn('p-2', 'bg-surface-raised')");
  });

  it('handles clsx and template literals', () => {
    const source = 'export const C = () => <div class={clsx(`bg-dark-800 p-1`)} />;';
    const { rewrites } = collectRewrites(source, 'sample.tsx', mapping);
    const next = applyRewrites(source, rewrites);
    expect(next).toContain('`bg-surface-raised p-1`');
  });

  it('rewrites template expression spans in class attributes', () => {
    const source =
      "export const D = ({ on }: { on: boolean }) => <div class={`p-2 bg-dark-800 ${on ? 'text-gray-400' : ''} mt-1`} />;";
    const { rewrites, changes } = collectRewrites(source, 'sample.tsx', mapping);
    const next = applyRewrites(source, rewrites);
    expect(changes.length).toBe(2);
    expect(next).toContain("`p-2 bg-surface-raised ${on ? 'text-fg-muted' : ''} mt-1`");
  });

  it('all-strings mode rewrites module-level records', () => {
    const source = "const STYLES = { dot: 'bg-dark-800', label: 'text-gray-400' };";
    const scoped = collectRewrites(source, 'sample.ts', mapping);
    expect(scoped.changes.length).toBe(0);
    const all = collectRewrites(source, 'sample.ts', mapping, true);
    const next = applyRewrites(source, all.rewrites);
    expect(all.changes.length).toBe(2);
    expect(next).toContain("dot: 'bg-surface-raised'");
    expect(next).toContain("label: 'text-fg-muted'");
  });
});

describe('countRawPalette', () => {
  it('counts palette, dark-scale, and white-alpha utilities', () => {
    const text = 'bg-blue-500 dark:bg-blue-500 bg-dark-800 bg-white/[0.07] text-white border-line';
    expect(countRawPalette(text)).toBe(5);
  });

  it('does not count semantic tokens', () => {
    expect(countRawPalette('bg-surface text-fg-muted border-line bg-accent/10')).toBe(0);
  });
});

describe('areaOf', () => {
  it('groups component subdirectories and islands', () => {
    expect(areaOf('components/space/SpaceTasks.tsx')).toBe('components/space');
    expect(areaOf('islands/MainContent.tsx')).toBe('islands');
    expect(areaOf('App.tsx')).toBe('(root)');
  });
});
