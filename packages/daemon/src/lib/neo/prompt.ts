import { NEO_ROOT_PROMPT, NEO_ROOT_TURN_END, NEO_FOCUSED_DISCUSSION } from '@hyperneo/prompts';
import type { NeoPackBrief } from './pack-contract.ts';

function neoPackBriefing(briefs: readonly NeoPackBrief[]): string {
  if (!briefs.length) return '';
  const skills = briefs.flatMap((pack) => (pack.skill ? [pack.skill] : []));
  return [
    `Domain packs carry the field an ask works in. Enabled packs: ${briefs
      .map((pack) => `${pack.id} — ${pack.describe}`)
      .join(' ')}`,
    'A todo in an enabled pack’s domain names it in check {pack, kind, params} so the pack reads it; neo.pack.read {id} returns the pack’s guidance in full.',
    ...(skills.length
      ? [`Load the pack guidance skills ${skills.join(', ')} before work in their domain.`]
      : []),
    ...briefs.flatMap((pack) =>
      pack.guidance ? [`\n\nGuidance for work under the ${pack.id} pack:\n${pack.guidance}`] : []
    ),
  ].join(' ');
}

export function neoPrompt(packs: readonly NeoPackBrief[]): string {
  const humanWork =
    'When the daemon reports that the human worked directly in a worker, treat it as news about that matter. Update the ask’s todos and state; record new work the human started as a todo on that ask. Do not assign again work the human already directed. If the worker succeeded and nothing needs the human, stay quiet. If failed or blocked, first try to unblock it yourself or through the worker using tools and access this instance actually has. Follow the human preferences supplied by enabled packs. Tell the human only what they must know or decide, with the concrete next step you propose.';
  return [
    NEO_ROOT_PROMPT,
    neoPackBriefing(packs),
    NEO_FOCUSED_DISCUSSION,
    humanWork,
    'Driver health events report local worker clients as ok, degraded, or unavailable. Before assigning work, read work.adapters and avoid degraded or unavailable drivers; tell the human the concrete reason and next step, without repeating an unchanged warning. A recovery event makes that driver eligible again. An unverified client version is still usable when health is ok: schedule its driver verify journey, then call work.health action verified with the adapter, passed journey, and exact tested clientVersions. Never record verification before observing that journey pass. Do not start work or change authentication as part of a read-only health check.',
    NEO_ROOT_TURN_END,
  ]
    .filter(Boolean)
    .join('\n\n');
}
