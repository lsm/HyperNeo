import {
  fillPrompt,
  NEO_CAPABILITIES_BRIEFING,
  NEO_HOLDER_CONSULTATION_RETURN,
  NEO_HOLDER_OPERATIONS,
  NEO_HOLDER_ROLE,
  NEO_HOLDER_SNAPSHOT_SCOPE,
  NEO_RESPONSE_FOCUS_BRIEFING,
  NEO_ROOT_CLARIFY,
  NEO_ROOT_CONSULTATION_RETURN,
  NEO_ROOT_OPERATIONS,
  NEO_ROOT_ROLE,
  NEO_ROOT_RULE_SAVE,
  NEO_ROOT_SNAPSHOT_SCOPE,
  NEO_SYSTEM_PROMPT,
} from '@hyperneo/prompts';

export function neoPrompt(concernId: string | null): string {
  return fillPrompt(NEO_SYSTEM_PROMPT, {
    capabilities: NEO_CAPABILITIES_BRIEFING,
    root_clarify: concernId ? '' : NEO_ROOT_CLARIFY,
    role: concernId
      ? fillPrompt(NEO_HOLDER_ROLE, { concern_id: JSON.stringify(concernId) })
      : NEO_ROOT_ROLE,
    snapshot_scope: concernId ? NEO_HOLDER_SNAPSHOT_SCOPE : NEO_ROOT_SNAPSHOT_SCOPE,
    rule_save: concernId ? '' : ` ${NEO_ROOT_RULE_SAVE}`,
    operations: concernId ? NEO_HOLDER_OPERATIONS : NEO_ROOT_OPERATIONS,
    consultation_return: concernId ? NEO_HOLDER_CONSULTATION_RETURN : NEO_ROOT_CONSULTATION_RETURN,
    response_focus: NEO_RESPONSE_FOCUS_BRIEFING,
  });
}
