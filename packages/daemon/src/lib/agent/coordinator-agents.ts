import type { AgentDefinition } from '@hyperneo/shared';
import { COORDINATOR_AGENT } from './coordinator/coordinator';
import { coderAgent } from './coordinator/coder';
import { debuggerAgent } from './coordinator/debugger';
import { testerAgent } from './coordinator/tester';
import { reviewerAgent } from './coordinator/reviewer';
import { vcsAgent } from './coordinator/vcs';
import { verifierAgent } from './coordinator/verifier';
const SPECIALIST_AGENTS: Record<string, AgentDefinition> = {
  Coder: coderAgent,
  Debugger: debuggerAgent,
  Tester: testerAgent,
  Reviewer: reviewerAgent,
  VCS: vcsAgent,
  Verifier: verifierAgent,
};

export function getCoordinatorAgents(
  userAgents?: Record<string, AgentDefinition>
): Record<string, AgentDefinition> {
  return {
    Coordinator: COORDINATOR_AGENT,
    ...userAgents,
    ...SPECIALIST_AGENTS,
  };
}
