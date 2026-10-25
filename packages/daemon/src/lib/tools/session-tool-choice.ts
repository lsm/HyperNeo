import type {
  AppMcpServer,
  AppSkill,
  McpEnablementOverride,
  SkillEnablementOverride,
} from '@hyperneo/shared';
import type {
  ResolvedSessionToolChoice,
  SessionToolChoiceKey,
  SessionToolSelection,
} from '@hyperneo/shared/types/session-tool-choice';
import type { ResolveMcpServersSession } from '../mcp/resolve-mcp-servers.ts';

export interface SessionToolChoiceInput {
  session: ResolveMcpServersSession;
  skills: readonly AppSkill[];
  registry: readonly AppMcpServer[];
  overrides: readonly McpEnablementOverride[];
  disabledSkillIds?: readonly string[];
  skillOverrides?: readonly SkillEnablementOverride[];
  denied?: readonly SessionToolChoiceKey[];
}

export function projectLegacySessionToolSelection(
  _input: SessionToolChoiceInput
): SessionToolSelection {
  return { version: 1, choices: {} };
}

export function resolveSessionToolChoices(
  _input: SessionToolChoiceInput,
  _selection: SessionToolSelection
): ResolvedSessionToolChoice[] {
  return [];
}
