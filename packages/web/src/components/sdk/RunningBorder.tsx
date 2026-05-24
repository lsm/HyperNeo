/**
 * RunningBorder — SVG-based animated border light for running task blocks.
 *
 * Uses SVG `animateMotion` + `mpath` to glide a masked white stroke exactly
 * around the element's border path. Adapts to any rendered size via
 * ResizeObserver so no hardcoded dimensions are required.
 *
 * Usage:
 *   <RunningBorder borderRadius={8}>
 *     <div class="border rounded-lg overflow-hidden">…</div>
 *   </RunningBorder>
 */

import { useRef, useLayoutEffect, useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';

// Monotonically-increasing counter for unique SVG def IDs per instance.
let _uid = 0;

interface RunningBorderProps {
  children: ComponentChildren;
  /** Border-radius in px; should match the wrapped card. Default: 8 (rounded-lg). */
  borderRadius?: number;
  /** One full revolution duration. Default: '6s'. */
  duration?: string;
  /** Extra classes applied to the outer wrapper div. */
  className?: string;
}

/**
 * Wraps `children` in a `position: relative` container, measures it, and
 * renders a path-following animated border light on top via an inline SVG.
 * The light follows the exact rounded-rectangle outline of the card.
 */
export function RunningBorder({
  children,
  borderRadius = 8,
  duration = '6s',
  className,
}: RunningBorderProps) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);

  useLayoutEffect(() => {
    const el = wrapperRef.current;
    if (!el) return;
    const measure = () => setSize({ w: el.offsetWidth, h: el.offsetHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return (
    <div ref={wrapperRef} class={`relative rounded-lg${className ? ` ${className}` : ''}`}>
      {children}
      {size && size.w > 0 && size.h > 0 && (
        <RunningBorderSVG w={size.w} h={size.h} r={borderRadius} duration={duration} />
      )}
    </div>
  );
}

// ── Internal SVG renderer ────────────────────────────────────────────────────

interface SVGProps {
  w: number;
  h: number;
  r: number;
  duration: string;
}

function RunningBorderSVG({ w, h, r, duration }: SVGProps) {
  // Stable unique ID assigned once per component instance.
  const idRef = useRef<string | null>(null);
  if (idRef.current === null) {
    idRef.current = `_rb${++_uid}`;
  }
  const uid = idRef.current;

  // SVG is 2 px larger on each side (inset: -1 px) so the stroke straddles
  // the card's outer edge rather than sitting inside it.
  const svgW = w + 2;
  const svgH = h + 2;

  // The rect path traces the card's outer border at (1, 1) in SVG coords.
  const pathD = roundedRectPath(1, 1, w, h, r);

  // Trail length and height — fixed values matching the reference design.
  // rx=120: trail arc length in px. ry=12: glow half-height; safe for any card
  // taller than ~24px (glow from opposite edges won't meet at centre).
  const trailRx = 120;
  const trailRy = 12;

  const gradId = `${uid}g`;
  const pathId = `${uid}p`;
  const maskId = `${uid}m`;

  return (
    <svg
      aria-hidden="true"
      class="absolute pointer-events-none"
      style={{ top: '-1px', left: '-1px', overflow: 'visible' }}
      width={svgW}
      height={svgH}
    >
      <defs>
        {/* Radial gradient: bright white center fading to transparent */}
        <radialGradient id={gradId} gradientUnits="objectBoundingBox" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="white" stopOpacity="1" />
          <stop offset="100%" stopColor="white" stopOpacity="0" />
        </radialGradient>

        {/* The path the light follows */}
        <path id={pathId} d={pathD} />

        {/* Mask: an animated radial ellipse sweeps along the path */}
        <mask id={maskId} maskUnits="userSpaceOnUse" x="0" y="0" width={svgW} height={svgH}>
          <ellipse rx={trailRx} ry={trailRy} fill={`url(#${gradId})`}>
            <animateMotion dur={duration} repeatCount="indefinite" rotate="auto">
              <mpath href={`#${pathId}`} />
            </animateMotion>
          </ellipse>
        </mask>
      </defs>

      {/* The border stroke — only visible inside the mask */}
      <rect
        x="1"
        y="1"
        width={w}
        height={h}
        rx={r}
        ry={r}
        fill="none"
        stroke="white"
        strokeWidth="2"
        mask={`url(#${maskId})`}
      />
    </svg>
  );
}

/** Build the SVG path for a rounded rectangle starting at (x, y). */
function roundedRectPath(x: number, y: number, w: number, h: number, r: number): string {
  return [
    `M ${x + r} ${y}`,
    `H ${x + w - r}`,
    `A ${r} ${r} 0 0 1 ${x + w} ${y + r}`,
    `V ${y + h - r}`,
    `A ${r} ${r} 0 0 1 ${x + w - r} ${y + h}`,
    `H ${x + r}`,
    `A ${r} ${r} 0 0 1 ${x} ${y + h - r}`,
    `V ${y + r}`,
    `A ${r} ${r} 0 0 1 ${x + r} ${y}`,
    'Z',
  ].join(' ');
}
