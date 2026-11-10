import type { Session, SessionMetadata, SpaceLongHorizonAgent } from '@hyperneo/shared';
import superpipe, { type PipelineAPI } from 'superpipe';

export type CloneChoice = 'cascade' | 'flatten';
export type CloneParentAction = 'archive' | 'delete';

export interface CloneSummary {
  id: string;
  title: string;
}

export interface ClonesRejection {
  accepted: false;
  reason: 'has_clones';
  clones: CloneSummary[];
}

export interface CloneAgentDependencies {
  readonly agentOwning: (sessionId: string) => SpaceLongHorizonAgent | null;
  readonly listAgents: (spaceId: string) => SpaceLongHorizonAgent[];
  readonly nameAgent: (
    agents: readonly SpaceLongHorizonAgent[],
    title: string
  ) => { handle: string; displayName: string };
  readonly createAgent: (
    params: Pick<
      SpaceLongHorizonAgent,
      | 'spaceId'
      | 'handle'
      | 'displayName'
      | 'sessionId'
      | 'instructions'
      | 'autonomyLevel'
      | 'model'
      | 'thinkingLevel'
      | 'provider'
      | 'settingSources'
      | 'toolPermissions'
    >
  ) => SpaceLongHorizonAgent;
  readonly stampProvenance: (
    sessionId: string,
    provenance: NonNullable<SessionMetadata['promptProvenance']>
  ) => Promise<void>;
}

export interface CloneCascadeDependencies {
  readonly listChildren: (parentId: string) => Session[];
  readonly detach: (sessionId: string) => Promise<void>;
  readonly agents?: CloneAgentDependencies;
  readonly archiveChild: (sessionId: string) => Promise<void>;
  readonly deleteChild: (sessionId: string) => Promise<void>;
}

export function isCloneChoice(value: unknown): value is CloneChoice {
  return value === 'cascade' || value === 'flatten';
}

export function admitCloneChoice(
  children: Session[],
  choice: CloneChoice | undefined
): { value: CloneChoice | 'none' } | { reason: ClonesRejection } {
  if (children.length === 0) return { value: 'none' };
  if (choice) return { value: choice };
  return {
    reason: {
      accepted: false,
      reason: 'has_clones',
      clones: children.map((child) => ({ id: child.id, title: child.title })),
    },
  };
}

export async function applyCloneChoice(
  choice: CloneChoice | 'none',
  parentId: string,
  action: CloneParentAction,
  children: Session[],
  deps: CloneCascadeDependencies
): Promise<boolean> {
  if (choice === 'none') return true;
  if (choice === 'cascade') {
    for (const child of children) {
      await applyCloneChoice('cascade', child.id, action, deps.listChildren(child.id), deps);
      await (action === 'delete' ? deps.deleteChild(child.id) : deps.archiveChild(child.id));
    }
    return true;
  }
  const agents = deps.agents;
  const owner = agents?.agentOwning(parentId);
  for (const child of children) {
    if (agents && owner) {
      const { handle, displayName } = agents.nameAgent(
        agents.listAgents(owner.spaceId),
        child.title
      );
      const agent = agents.createAgent({
        spaceId: owner.spaceId,
        handle,
        displayName,
        sessionId: child.id,
        instructions: owner.instructions,
        autonomyLevel: owner.autonomyLevel,
        model: owner.model,
        thinkingLevel: owner.thinkingLevel,
        provider: owner.provider,
        settingSources: owner.settingSources,
        toolPermissions: owner.toolPermissions,
      });
      await agents.stampProvenance(child.id, {
        source: 'flattened_clone',
        hash: agent.id,
        agentId: agent.id,
        agentName: agent.handle,
      });
    }
    await deps.detach(child.id);
  }
  return true;
}

export type ResolveClones = (
  parentId: string,
  choice: CloneChoice | undefined,
  action: CloneParentAction
) => Promise<ClonesRejection | null>;

export function createResolveClones(deps: CloneCascadeDependencies): ResolveClones {
  const run = (superpipe({ deps })('resolve-session-clones') as PipelineAPI)
    .input(['parentId', 'choice', 'action'])
    .pipe((parentId: string) => deps.listChildren(parentId), 'parentId', 'children')
    .pipe(admitCloneChoice, ['children', 'choice'], 'result:outcome')
    .pipe(applyCloneChoice, ['outcome', 'parentId', 'action', 'children', 'deps'], 'applied')
    .endAsync(['outcome', 'applied']) as (
    parentId: string,
    choice: CloneChoice | undefined,
    action: CloneParentAction
  ) => Promise<[unknown, unknown]>;
  return async (parentId, choice, action) => {
    const [outcome] = await run(parentId, choice, action);
    return typeof outcome === 'object' && outcome !== null && 'accepted' in outcome
      ? (outcome as ClonesRejection)
      : null;
  };
}
