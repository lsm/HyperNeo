import type { SpaceAgent } from '@hyperneo/shared';
import superpipe, { type PipelineAPI } from 'superpipe';

export interface DeepLinkState {
  appliedLink: string | null;
  appliedAgentId: string | null;
  handledLink: string | null;
  selectedId: string | null;
}

export interface DeepLinkInput {
  spaceId: string;
  selectedHandle?: string | null;
  agents: SpaceAgent[];
  state: DeepLinkState;
}

export type DeepLinkDecision =
  | { kind: 'forget' }
  | { kind: 'idle' }
  | { kind: 'clear'; link: string; clearSelection: boolean }
  | { kind: 'apply'; link: string; agentId: string };

export interface LinkedRequest {
  input: DeepLinkInput;
  link: string;
}

export interface MatchedRequest extends LinkedRequest {
  target: SpaceAgent;
}

export type DeepLinkGate<T> = { value: T } | { reason: DeepLinkDecision };

const COORDINATOR_ALIASES = new Set(['space-manager', 'coordinator']);

export function deepLinkKey(spaceId: string, selectedHandle?: string | null): string | null {
  return selectedHandle ? `${spaceId} ${selectedHandle}` : null;
}

export function matchesSelectedHandle(agent: SpaceAgent, handle: string): boolean {
  if (agent.handle === handle) return true;
  return handle === 'coordinator' && COORDINATOR_ALIASES.has(agent.handle);
}

export function findLinkTarget(input: DeepLinkInput): SpaceAgent | null {
  const handle = input.selectedHandle;
  if (!handle) return null;
  const found = input.agents.find((agent) => matchesSelectedHandle(agent, handle));
  if (!found) return null;
  return found.spaceId === input.spaceId ? found : null;
}

export function gateHandlePresent(input: DeepLinkInput): DeepLinkGate<LinkedRequest> {
  const link = deepLinkKey(input.spaceId, input.selectedHandle);
  if (!link) return { reason: { kind: 'forget' } };
  return { value: { input, link } };
}

export function gateTargetPresent(linked: LinkedRequest): DeepLinkGate<MatchedRequest> {
  const target = findLinkTarget(linked.input);
  if (target) return { value: { ...linked, target } };

  const { state } = linked.input;
  const alreadyCleared = state.handledLink === linked.link && state.appliedLink === null;
  if (alreadyCleared) return { reason: { kind: 'idle' } };
  const isNewLink = state.handledLink !== linked.link;
  const selectionWasLinked = state.selectedId !== null && state.selectedId === state.appliedAgentId;
  return {
    reason: {
      kind: 'clear',
      link: linked.link,
      clearSelection: isNewLink || selectionWasLinked,
    },
  };
}

export function gateNotYetApplied(matched: MatchedRequest): DeepLinkGate<MatchedRequest> {
  const { state } = matched.input;
  const unchanged =
    state.appliedLink === matched.link && state.appliedAgentId === matched.target.id;
  if (unchanged) return { reason: { kind: 'idle' } };
  return { value: matched };
}

export function toApplyDecision(matched: MatchedRequest): DeepLinkDecision {
  return { kind: 'apply', link: matched.link, agentId: matched.target.id };
}

export const decideDeepLink = (superpipe({})('deep-link-selection') as PipelineAPI)
  .input(['input'])
  .pipe(gateHandlePresent, 'input', 'result:decided')
  .pipe(gateTargetPresent, 'decided', 'result:decided')
  .pipe(gateNotYetApplied, 'decided', 'result:decided')
  .pipe(toApplyDecision, 'decided', 'decided')
  .end('decided') as (input: DeepLinkInput) => DeepLinkDecision;
