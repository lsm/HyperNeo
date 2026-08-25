import type { AgentDefinition } from '@hyperneo/shared';
import { COORDINATOR_AGENT } from './coordinator/coordinator.ts';
import { coderAgent } from './coordinator/coder.ts';
import { debuggerAgent } from './coordinator/debugger.ts';
import { testerAgent } from './coordinator/tester.ts';
import { reviewerAgent } from './coordinator/reviewer.ts';
import { vcsAgent } from './coordinator/vcs.ts';
import { verifierAgent } from './coordinator/verifier.ts';
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
