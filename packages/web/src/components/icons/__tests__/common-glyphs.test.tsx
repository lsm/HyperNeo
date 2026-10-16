import { render, fireEvent } from '@testing-library/preact';
import type { JSX } from 'preact';
import { describe, expect, it, vi } from 'vitest';
import {
  CloseGlyph,
  CheckGlyph,
  ChevronDownGlyph,
  ChevronRightGlyph,
  ChevronLeftGlyph,
  ChevronUpGlyph,
} from '../common-glyphs.tsx';

const glyphs = [
  [CloseGlyph, 'M6 18L18 6M6 6l12 12'],
  [CheckGlyph, 'M5 13l4 4L19 7'],
  [ChevronDownGlyph, 'M19 9l-7 7-7-7'],
  [ChevronRightGlyph, 'M9 5l7 7-7 7'],
  [ChevronLeftGlyph, 'M15 19l-7-7 7-7'],
  [ChevronUpGlyph, 'M5 15l7-7 7 7'],
] as const;

function attributes(element: Element | null) {
  return Array.from(element?.attributes ?? [], (attribute) => [
    attribute.name,
    attribute.value,
  ]).sort();
}

const cases: {
  name: string;
  original: JSX.SVGAttributes<SVGPathElement>;
  pathProps?: JSX.SVGAttributes<SVGPathElement>;
}[] = [
  {
    name: 'hyphenated defaults',
    original: { 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'stroke-width': 2 },
  },
  {
    name: 'camelCase callers',
    original: { strokeLinecap: 'round', strokeLinejoin: 'round', strokeWidth: 2 },
    pathProps: { strokeLinecap: 'round', strokeLinejoin: 'round', strokeWidth: 2 },
  },
  { name: 'inherited path attributes', original: {}, pathProps: {} },
  {
    name: 'caller stroke width',
    original: { 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'stroke-width': 2.5 },
    pathProps: { 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'stroke-width': 2.5 },
  },
];

describe('shared glyph migration parity', () => {
  it.each(cases)('preserves actual SVG DOM attributes for $name', ({ original, pathProps }) => {
    for (const [Glyph, d] of glyphs) {
      const onClick = vi.fn();
      const outer = {
        class: 'h-4 text-fg-muted',
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        'stroke-width': 3,
        'aria-hidden': true as const,
        onClick,
      };
      const before = render(
        <svg {...outer}>
          <path {...original} d={d} />
        </svg>
      );
      const after = render(<Glyph {...outer} pathProps={pathProps} />);
      expect(attributes(after.container.querySelector('svg'))).toEqual(
        attributes(before.container.querySelector('svg'))
      );
      expect(attributes(after.container.querySelector('path'))).toEqual(
        attributes(before.container.querySelector('path'))
      );
      fireEvent.click(after.container.querySelector('svg')!);
      expect(onClick).toHaveBeenCalledTimes(1);
      before.unmount();
      after.unmount();
    }
  });
});
