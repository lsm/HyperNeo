export const SESSION_WRITE_AUTONOMY_LEVEL = 4;

export interface EffectiveAutonomyInput {
  spaceLevel: number;
  agentLevel: number | null;
}

export interface EffectiveAutonomy {
  level: number;
  agentCeilingBinding: boolean;
}

export function resolveEffectiveAutonomyLevel(input: EffectiveAutonomyInput): EffectiveAutonomy {
  const { spaceLevel, agentLevel } = input;
  const level = agentLevel == null ? spaceLevel : Math.min(spaceLevel, agentLevel);
  const agentCeilingBinding = agentLevel != null && agentLevel < spaceLevel;
  return { level, agentCeilingBinding };
}

export type AutonomyAdmissionDenyReason = 'agent_autonomy_ceiling' | 'space_autonomy_level';

export type AutonomyAdmissionDecision =
  | { action: 'allow' }
  | {
      action: 'deny';
      reason: AutonomyAdmissionDenyReason;
      agentLevel?: number;
      spaceLevel: number;
      required: number;
      message: string;
    };

export interface AutonomyAdmissionInput {
  toolName: string;
  level: number;
  required: number;
  agentLevel: number | null;
  spaceLevel: number;
}

export function isAgentCeilingBinding(
  spaceLevel: number,
  agentLevel: number | null
): agentLevel is number {
  return agentLevel != null && agentLevel < spaceLevel;
}

export function decideAutonomyAdmission(input: AutonomyAdmissionInput): AutonomyAdmissionDecision {
  const { toolName, level, required, agentLevel, spaceLevel } = input;
  if (level >= required) {
    return { action: 'allow' };
  }
  if (isAgentCeilingBinding(spaceLevel, agentLevel)) {
    return {
      action: 'deny',
      reason: 'agent_autonomy_ceiling',
      agentLevel,
      spaceLevel,
      required,
      message: `${toolName} not permitted: agent autonomy ceiling ${agentLevel} (space ${spaceLevel}) < required level ${required}. Request human approval.`,
    };
  }
  return {
    action: 'deny',
    reason: 'space_autonomy_level',
    spaceLevel,
    required,
    message: `${toolName} not permitted: space autonomy level ${spaceLevel} < required level ${required}. Request human approval.`,
  };
}

export const TOOL_AUTONOMY_REQUIREMENTS: Record<string, number> = {
  send_session_message: SESSION_WRITE_AUTONOMY_LEVEL,
  update_session_state: SESSION_WRITE_AUTONOMY_LEVEL,
  interrupt_session: SESSION_WRITE_AUTONOMY_LEVEL,
};

export function getToolAutonomyRequirement(toolName: string): number | undefined {
  return Object.hasOwn(TOOL_AUTONOMY_REQUIREMENTS, toolName)
    ? TOOL_AUTONOMY_REQUIREMENTS[toolName]
    : undefined;
}
