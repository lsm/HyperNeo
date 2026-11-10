import {
  NEO_PACK_CHECK,
  NEO_HUMAN_WORK,
  NEO_DRIVER_HEALTH,
  NEO_ROOT_PROMPT,
  NEO_ROOT_TURN_END,
  NEO_FOCUSED_DISCUSSION,
  NEO_STANDING_RULES,
  NEO_PACK_PREFERENCES,
  fillPrompt,
} from '@hyperneo/prompts';
import type { NeoPackSetting } from '@hyperneo/shared/types/neo-snapshot';
import type { NeoPackBrief } from './pack-contract.ts';

function neoPackBriefing(briefs: readonly NeoPackBrief[]): string {
  if (!briefs.length) return '';
  const skills = briefs.flatMap((pack) => (pack.skill ? [pack.skill] : []));
  return [
    `Domain packs carry the field an ask works in. Enabled packs: ${briefs
      .map((pack) => `${pack.id} — ${pack.describe}`)
      .join(' ')}`,
    NEO_PACK_CHECK,
    ...(skills.length
      ? [`Before work in an enabled pack’s domain, load its guidance skill: ${skills.join(', ')}.`]
      : []),
    ...briefs.flatMap((pack) =>
      pack.guidance ? [`\n\nGuidance for work under the ${pack.id} pack:\n${pack.guidance}`] : []
    ),
  ].join(' ');
}

function neoStandingRulesPrompt(rules: readonly string[]): string {
  if (!rules.length) return '';
  return fillPrompt(NEO_STANDING_RULES, {
    rules: rules.map((rule, index) => `${index + 1}. ${rule}`).join('\n'),
  });
}

function neoPackPreferencesPrompt(settings: readonly NeoPackSetting[]): string {
  if (!settings.length) return '';
  return fillPrompt(NEO_PACK_PREFERENCES, {
    preferences: settings
      .map(({ pack, scope, key, value }) => JSON.stringify({ pack, scope, key, value }))
      .join('\n'),
  });
}

export function neoPrompt(
  packs: readonly NeoPackBrief[],
  rules: readonly string[] = [],
  settings: readonly NeoPackSetting[] = []
): string {
  return [
    NEO_ROOT_PROMPT,
    neoStandingRulesPrompt(rules),
    neoPackPreferencesPrompt(settings),
    neoPackBriefing(packs),
    NEO_FOCUSED_DISCUSSION,
    NEO_HUMAN_WORK,
    NEO_DRIVER_HEALTH,
    NEO_ROOT_TURN_END,
  ]
    .filter(Boolean)
    .join('\n\n');
}
