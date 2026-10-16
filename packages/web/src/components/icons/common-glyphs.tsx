import type { JSX } from 'preact';

type GlyphProps = Omit<JSX.SVGAttributes<SVGSVGElement>, 'children' | 'ref'> & {
  pathProps?: JSX.SVGAttributes<SVGPathElement>;
};

const defaultPathProps: JSX.SVGAttributes<SVGPathElement> = {
  'stroke-linecap': 'round',
  'stroke-linejoin': 'round',
  'stroke-width': 2,
};

export function CloseGlyph({ pathProps = defaultPathProps, ...props }: GlyphProps) {
  return (
    <svg {...props}>
      <path {...pathProps} d="M6 18L18 6M6 6l12 12" />
    </svg>
  );
}

export function CheckGlyph({ pathProps = defaultPathProps, ...props }: GlyphProps) {
  return (
    <svg {...props}>
      <path {...pathProps} d="M5 13l4 4L19 7" />
    </svg>
  );
}

export function ChevronDownGlyph({ pathProps = defaultPathProps, ...props }: GlyphProps) {
  return (
    <svg {...props}>
      <path {...pathProps} d="M19 9l-7 7-7-7" />
    </svg>
  );
}

export function ChevronRightGlyph({ pathProps = defaultPathProps, ...props }: GlyphProps) {
  return (
    <svg {...props}>
      <path {...pathProps} d="M9 5l7 7-7 7" />
    </svg>
  );
}

export function ChevronLeftGlyph({ pathProps = defaultPathProps, ...props }: GlyphProps) {
  return (
    <svg {...props}>
      <path {...pathProps} d="M15 19l-7-7 7-7" />
    </svg>
  );
}

export function ChevronUpGlyph({ pathProps = defaultPathProps, ...props }: GlyphProps) {
  return (
    <svg {...props}>
      <path {...pathProps} d="M5 15l7-7 7 7" />
    </svg>
  );
}
