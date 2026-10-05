import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import type { Database as BunDatabase } from '../../storage/sqlite-compat.ts';
import { defineOperation } from '../operations/registry.ts';

export const AgentReferenceSchema = z.object({
  space: z.string().trim().min(1).describe('Space id, slug or name'),
  agent: z.string().trim().min(1).describe('Agent id, @handle or display name'),
});

export type AgentReference = z.infer<typeof AgentReferenceSchema>;

export interface ReferenceSpace {
  id: string;
  slug: string;
  name: string;
}

export interface ReferenceAgent {
  id: string;
  handle: string;
  displayName: string;
}

export interface ResolvedAgent {
  spaceId: string;
  spaceSlug: string;
  agentId: string;
  handle: string;
  displayName: string;
}

export interface AgentReferenceLookups {
  listSpaces(): ReferenceSpace[];
  listAgents(spaceId: string): ReferenceAgent[];
}

type Resolution<T> = { value: T } | { reason: string };
type Match<T> = (row: T, needle: string) => boolean;

const CANDIDATE_LIMIT = 20;

export function bareHandle(value: string): string {
  return value.trim().replace(/^@/, '').toLowerCase();
}

export function listCandidates(labels: string[]): string {
  const shown = labels.slice(0, CANDIDATE_LIMIT);
  const more = labels.length - shown.length;
  return shown.join(', ') + (more > 0 ? ` and ${more} more` : '');
}

export function pickByReference<T>(
  ref: string,
  kind: string,
  rows: readonly T[],
  passes: readonly Match<T>[],
  label: (row: T) => string
): Resolution<T> {
  const needle = ref.trim().toLowerCase();
  for (const pass of passes) {
    const matches = rows.filter((row) => pass(row, needle));
    if (matches.length === 1) return { value: matches[0] };
    if (matches.length > 1)
      return {
        reason: `${kind} "${ref}" is ambiguous; use one of: ${listCandidates(matches.map(label))}`,
      };
  }
  return {
    reason: rows.length
      ? `No ${kind} matches "${ref}"; known: ${listCandidates(rows.map(label))}`
      : `No ${kind} matches "${ref}"`,
  };
}

const SPACE_PASSES: readonly Match<ReferenceSpace>[] = [
  (space, needle) => space.id.toLowerCase() === needle,
  (space, needle) => space.slug.toLowerCase() === needle,
  (space, needle) => space.name.trim().toLowerCase() === needle,
];

const AGENT_PASSES: readonly Match<ReferenceAgent>[] = [
  (agent, needle) => agent.id.toLowerCase() === needle,
  (agent, needle) => bareHandle(agent.handle) === bareHandle(needle),
  (agent, needle) => agent.displayName.trim().toLowerCase() === needle,
];

export interface AgentReferenceRejection {
  rejected: string;
}

type Gate<T> = { value: T } | { reason: AgentReferenceRejection };

function asGate<T>(picked: Resolution<T>): Gate<T> {
  return 'value' in picked ? picked : { reason: { rejected: picked.reason } };
}

export function listReferenceSpaces(lookups: AgentReferenceLookups): ReferenceSpace[] {
  return lookups.listSpaces();
}

export function pickReferenceSpace(
  ref: AgentReference,
  spaces: readonly ReferenceSpace[]
): Gate<{ space: ReferenceSpace }> {
  const picked = pickByReference(ref.space, 'space', spaces, SPACE_PASSES, (space) => space.slug);
  return 'value' in picked ? { value: { space: picked.value } } : asGate(picked);
}

export function listReferenceAgents(
  resolution: { space: ReferenceSpace },
  lookups: AgentReferenceLookups
): ReferenceAgent[] {
  return lookups.listAgents(resolution.space.id);
}

export function describeResolvedAgent(space: ReferenceSpace, agent: ReferenceAgent): ResolvedAgent {
  return {
    spaceId: space.id,
    spaceSlug: space.slug,
    agentId: agent.id,
    handle: `@${bareHandle(agent.handle)}`,
    displayName: agent.displayName,
  };
}

export function pickReferenceAgent(
  resolution: { space: ReferenceSpace },
  ref: AgentReference,
  agents: readonly ReferenceAgent[]
): Gate<ResolvedAgent> {
  const picked = pickByReference(
    ref.agent,
    'agent',
    agents,
    AGENT_PASSES,
    (agent) => `@${bareHandle(agent.handle)} (${agent.displayName})`
  );
  return 'value' in picked
    ? { value: describeResolvedAgent(resolution.space, picked.value) }
    : asGate(picked);
}

const runResolveAgentReference = (superpipe({})('resolve-agent-reference') as PipelineAPI)
  .input(['ref', 'lookups'])
  .pipe(listReferenceSpaces, 'lookups', 'spaces')
  .pipe(pickReferenceSpace, ['ref', 'spaces'], 'result:resolution')
  .pipe(listReferenceAgents, ['resolution', 'lookups'], 'agents')
  .pipe(pickReferenceAgent, ['resolution', 'ref', 'agents'], 'result:resolution')
  .end('resolution') as (
  ref: AgentReference,
  lookups: AgentReferenceLookups
) => ResolvedAgent | AgentReferenceRejection;

function settle<T extends object>(outcome: T | AgentReferenceRejection): Resolution<T> {
  return 'rejected' in outcome ? { reason: outcome.rejected } : { value: outcome };
}

export function resolveAgentReference(
  ref: AgentReference,
  lookups: AgentReferenceLookups
): Resolution<ResolvedAgent> {
  return settle(runResolveAgentReference(ref, lookups));
}

export function createAgentReferenceLookups(db: () => BunDatabase): AgentReferenceLookups {
  return {
    listSpaces: () =>
      db()
        .prepare(`SELECT id, slug, name FROM spaces WHERE status != 'archived' ORDER BY slug`)
        .all() as ReferenceSpace[],
    listAgents: (spaceId) =>
      db()
        .prepare(
          `SELECT id, handle, display_name AS displayName FROM space_long_horizon_agents
            WHERE space_id = ? AND status != 'archived' ORDER BY handle`
        )
        .all(spaceId) as ReferenceAgent[],
  };
}

const ResolvedAgentSchema = z.object({
  spaceId: z.string(),
  spaceSlug: z.string(),
  agentId: z.string(),
  handle: z.string(),
  displayName: z.string(),
});

export function createResolveAgentOperation(lookups: AgentReferenceLookups) {
  return defineOperation({
    name: 'agent.resolve',
    description:
      'Resolve an agent mention to one agent in any Space: the space by id, slug or name, the agent by id, @handle or display name (exact, case-insensitive, in that order). An unknown or ambiguous name is rejected with the candidates to choose from. Read only; it does not start a session.',
    inputSchema: AgentReferenceSchema,
    resultSchema: z.union([
      z.object({ resolved: z.literal(true), agent: ResolvedAgentSchema }),
      z.object({ resolved: z.literal(false), reason: z.string() }),
    ]),
    execute: async (input) => {
      const outcome = resolveAgentReference(input, lookups);
      return 'value' in outcome
        ? { resolved: true as const, agent: outcome.value }
        : { resolved: false as const, reason: outcome.reason };
    },
  });
}

export type EnsureReferencedAgentSession = (target: {
  kind: 'agent';
  spaceId: string;
  agentId: string;
}) => Promise<{ kind: 'resolved'; sessionId: string } | { kind: 'unresolved'; reason: string }>;

export function admitReferencedAgent(
  ref: AgentReference,
  lookups: AgentReferenceLookups
): Gate<ResolvedAgent> {
  const outcome = runResolveAgentReference(ref, lookups);
  return 'rejected' in outcome ? { reason: outcome } : { value: outcome };
}

export async function ensureReferencedAgentSession(
  agent: ResolvedAgent,
  ensure: EnsureReferencedAgentSession
): Promise<Gate<{ sessionId: string }>> {
  const outcome = await ensure({ kind: 'agent', spaceId: agent.spaceId, agentId: agent.agentId });
  return outcome.kind === 'resolved'
    ? { value: { sessionId: outcome.sessionId } }
    : {
        reason: {
          rejected: `${agent.handle} in ${agent.spaceSlug} has no session that can receive messages (${outcome.reason})`,
        },
      };
}

const runResolveAgentSession = (superpipe({})('resolve-agent-session') as PipelineAPI)
  .input(['ref', 'lookups', 'ensure'])
  .pipe(admitReferencedAgent, ['ref', 'lookups'], 'result:delivery')
  .pipe(ensureReferencedAgentSession, ['delivery', 'ensure'], 'result:delivery')
  .endAsync('delivery') as (
  ref: AgentReference,
  lookups: AgentReferenceLookups,
  ensure: EnsureReferencedAgentSession
) => Promise<{ sessionId: string } | AgentReferenceRejection>;

export function createAgentSessionResolver(
  lookups: AgentReferenceLookups,
  ensure: EnsureReferencedAgentSession
) {
  return async (ref: AgentReference): Promise<Resolution<string>> => {
    const outcome = settle(await runResolveAgentSession(ref, lookups, ensure));
    return 'value' in outcome ? { value: outcome.value.sessionId } : outcome;
  };
}
