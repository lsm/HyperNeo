/**
 * Indicator Tokens
 *
 * Unified tone palette for status, activity, and attention indicators across
 * the HyperNeo web UI. Each tone exports solid background, text, border, and
 * soft badge class sets so dots, badges, spinners, and banners stay consistent.
 */

/**
 * Tone names in the unified indicator palette.
 */
export const INDICATOR_TONE_NAMES = [
  'neutral',
  'info',
  'progress',
  'success',
  'warning',
  'danger',
  'special',
] as const;

/**
 * A tone from the unified indicator palette.
 */
export type IndicatorTone = (typeof INDICATOR_TONE_NAMES)[number];

/**
 * Class set for a single indicator tone.
 */
export interface ToneClassSet {
  /** Solid background class for dots, spinners, and solid badges. */
  bg: string;
  /** Text color class. */
  text: string;
  /** Opaque border class. */
  border: string;
  /** Pre-composed soft badge class string (border + background + text). */
  soft: string;
  /**
   * Solid border class for spinners and other solid-border indicators.
   * Stored as a complete literal (not derived from `bg`) so Tailwind's JIT
   * scanner emits the utility for every tone.
   */
  spinner: string;
}

/**
 * Unified tone palette. Every status/activity indicator should derive its
 * classes from one of these tones.
 */
export const INDICATOR_TONES: Record<IndicatorTone, ToneClassSet> = {
  neutral: {
    bg: 'bg-gray-500',
    text: 'text-gray-400',
    border: 'border-gray-500/30',
    soft: 'border-gray-500/30 bg-gray-500/10 text-gray-400',
    spinner: 'border-gray-500',
  },
  info: {
    bg: 'bg-blue-500',
    text: 'text-blue-400',
    border: 'border-blue-500/30',
    soft: 'border-blue-500/30 bg-blue-500/10 text-blue-400',
    spinner: 'border-blue-500',
  },
  progress: {
    bg: 'bg-yellow-500',
    text: 'text-yellow-400',
    border: 'border-yellow-500/30',
    soft: 'border-yellow-500/30 bg-yellow-500/10 text-yellow-400',
    spinner: 'border-yellow-500',
  },
  success: {
    bg: 'bg-green-500',
    text: 'text-green-400',
    border: 'border-green-500/30',
    soft: 'border-green-500/30 bg-green-500/10 text-green-400',
    spinner: 'border-green-500',
  },
  warning: {
    bg: 'bg-amber-500',
    text: 'text-amber-400',
    border: 'border-amber-500/30',
    soft: 'border-amber-500/30 bg-amber-500/10 text-amber-400',
    spinner: 'border-amber-500',
  },
  danger: {
    bg: 'bg-red-500',
    text: 'text-red-400',
    border: 'border-red-500/30',
    soft: 'border-red-500/30 bg-red-500/10 text-red-400',
    spinner: 'border-red-500',
  },
  special: {
    bg: 'bg-purple-500',
    text: 'text-purple-400',
    border: 'border-purple-500/30',
    soft: 'border-purple-500/30 bg-purple-500/10 text-purple-400',
    spinner: 'border-purple-500',
  },
};

/**
 * Return the class set for a given indicator tone.
 */
export function getToneClasses(tone: IndicatorTone): ToneClassSet {
  return INDICATOR_TONES[tone];
}
