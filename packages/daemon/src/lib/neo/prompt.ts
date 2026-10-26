import { NEO_ROOT_PROMPT, NEO_ROOT_TURN_END, NEO_FOCUSED_DISCUSSION } from '@hyperneo/prompts';
import type { NeoPackBrief } from './pack-contract.ts';

function neoPackBriefing(briefs: readonly NeoPackBrief[]): string {
  if (!briefs.length) return '';
  return [
    `Domain packs carry the field an ask works in. Enabled packs: ${briefs
      .map((pack) => `${pack.id} — ${pack.describe}`)
      .join(' ')}`,
    'A todo in an enabled pack’s domain names it in check {pack, kind, params} so the pack reads it; neo.pack.read {id} returns the pack’s guidance in full.',
    ...briefs.flatMap((pack) =>
      pack.guidance ? [`\n\nGuidance for work under the ${pack.id} pack:\n${pack.guidance}`] : []
    ),
  ].join(' ');
}

export function neoPrompt(packs: readonly NeoPackBrief[]): string {
  return [NEO_ROOT_PROMPT, neoPackBriefing(packs), NEO_FOCUSED_DISCUSSION, NEO_ROOT_TURN_END]
    .filter(Boolean)
    .join('\n\n');
}
