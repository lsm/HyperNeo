import {
  fillPrompt,
  NEO_CAPABILITIES_BRIEFING,
  NEO_DONE_CHECK_STEPS,
  NEO_HOLDER_CONSULTATION_RETURN,
  NEO_LOOK_UP,
  NEO_HOLDER_OPERATIONS,
  NEO_HOLDER_ROLE,
  NEO_HOLDER_SNAPSHOT_SCOPE,
  NEO_SPEAKING_POLICY,
  NEO_ROOT_PROMPT,
  NEO_SYSTEM_PROMPT,
} from '@hyperneo/prompts';
import type { NeoPackBrief } from './packs/types.ts';
import { neoSettingsPackBriefs } from './packs/index.ts';

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

export function neoPrompt(
  projectId: string | null,
  packs: readonly NeoPackBrief[] = neoSettingsPackBriefs()
): string {
  if (!projectId) return [NEO_ROOT_PROMPT, neoPackBriefing(packs)].filter(Boolean).join('\n\n');
  return fillPrompt(NEO_SYSTEM_PROMPT, {
    capabilities: NEO_CAPABILITIES_BRIEFING,
    root_clarify: '',
    role: fillPrompt(NEO_HOLDER_ROLE, { project_id: JSON.stringify(projectId) }),
    snapshot_scope: NEO_HOLDER_SNAPSHOT_SCOPE,
    rule_save: '',
    packs: neoPackBriefing(packs),
    done_check_steps: NEO_DONE_CHECK_STEPS,
    operations: NEO_HOLDER_OPERATIONS,
    consultation_return: NEO_HOLDER_CONSULTATION_RETURN,
    speaking_policy: NEO_SPEAKING_POLICY,
    look_up: NEO_LOOK_UP,
  });
}
