import type { SpaceLongHorizonAgent } from '@hyperneo/shared';
import type { OperationCaller } from '../registry.ts';

export type AgentListReader = (spaceId: string, caller: OperationCaller) => SpaceLongHorizonAgent[];
export type AgentReader = (
  agentId: string,
  caller: OperationCaller
) => SpaceLongHorizonAgent | null;

export interface AgentOperationDependencies {
  listAgents?: AgentListReader;
  getAgent?: AgentReader;
}
