import type { SpaceAutonomyLevel } from '@hyperneo/shared';

export const AUTONOMY_LEVELS: {
  level: SpaceAutonomyLevel;
  label: string;
  description: string;
}[] = [
  { level: 1, label: 'Supervised', description: 'All actions need approval' },
  { level: 2, label: 'Mostly supervised', description: 'Routine actions auto-approved' },
  { level: 3, label: 'Balanced', description: 'Judgment calls need approval' },
  { level: 4, label: 'Mostly autonomous', description: 'Only high-risk needs approval' },
  { level: 5, label: 'Fully autonomous', description: 'All actions auto-approved' },
];

export const AUTONOMY_LABELS = Object.fromEntries(
  AUTONOMY_LEVELS.map(({ level, label }) => [level, label])
) as Record<SpaceAutonomyLevel, string>;
