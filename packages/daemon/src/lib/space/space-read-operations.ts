import type { Space } from '@hyperneo/shared';
import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import {
  defineOperation,
  type OperationCaller,
  type OperationDefinition,
  type OperationPolicy,
} from '../operations/registry.ts';

export interface SpaceReadDependencies {
  readonly listSpaces: (includeArchived: boolean) => Space[] | Promise<Space[]>;
  readonly getSpace: (spaceId: string) => Space | null | Promise<Space | null>;
}

export type SpaceSummary = Pick<Space, 'id' | 'slug' | 'name' | 'status' | 'paused' | 'stopped'>;

export const SpaceSummarySchema = z
  .object({
    id: z.string().describe('Space id; pass this as spaceId to a Space-scoped operation.'),
    slug: z.string().describe('Stable url-safe handle for the Space.'),
    name: z.string().describe('Human name of the Space.'),
    status: z.enum(['active', 'archived']).describe('Lifecycle status of the Space.'),
    paused: z.boolean().describe('Whether the Space is paused; paused Spaces start no new work.'),
    stopped: z.boolean().describe('Whether the Space is stopped; stopped Spaces run nothing.'),
  })
  .strict() satisfies z.ZodType<SpaceSummary>;

const ListInputSchema = z
  .object({
    includeArchived: z
      .boolean()
      .optional()
      .describe('Include archived Spaces. Archived Spaces are excluded by default.'),
  })
  .strict()
  .default({});

const OutsideSpaceRejectionSchema = z
  .object({ accepted: z.literal(false), reason: z.literal('outside_space') })
  .strict();

const ListResultSchema = z.union([
  z.object({ spaces: z.array(SpaceSummarySchema) }).strict(),
  OutsideSpaceRejectionSchema,
]);

const GetInputSchema = z.object({ spaceId: z.string().min(1).describe('Space id') }).strict();

const GetResultSchema = z.union([
  z.object({ found: z.literal(true), space: SpaceSummarySchema }),
  z.object({ found: z.literal(false), spaceId: z.string() }),
  OutsideSpaceRejectionSchema,
]);

const OUTSIDE_SPACE = { accepted: false, reason: 'outside_space' } as const;

function isOutsideSpace(caller: OperationCaller): boolean {
  return caller.source === 'mcp' && !SPACE_DISCOVERY_POLICY.roles.some((r) => r === caller.role);
}

type ListInput = z.infer<typeof ListInputSchema>;
type ListResult = z.infer<typeof ListResultSchema>;
type GetInput = z.infer<typeof GetInputSchema>;
type GetResult = z.infer<typeof GetResultSchema>;

export const SPACE_DISCOVERY_POLICY = {
  safetyClass: 'read',
  roles: [
    'ad_hoc_member',
    'long_term_agent',
    'workflow_worker',
    'direct_task_worker',
    'legacy_task_agent',
  ],
} as const satisfies OperationPolicy;

export function summarizeSpace(space: Space): SpaceSummary {
  return {
    id: space.id,
    slug: space.slug,
    name: space.name,
    status: space.status,
    paused: space.paused,
    stopped: space.stopped,
  };
}

export async function readSpaceListing(
  input: ListInput,
  deps: SpaceReadDependencies
): Promise<Space[]> {
  return deps.listSpaces(input.includeArchived ?? false);
}

export function summarizeSpaceListing(spaces: Space[]): ListResult {
  return { spaces: spaces.map(summarizeSpace) };
}

export async function findSpaceById(
  input: GetInput,
  deps: SpaceReadDependencies
): Promise<{ value: Space } | { reason: Extract<GetResult, { found: false }> }> {
  const space = await deps.getSpace(input.spaceId);
  return space ? { value: space } : { reason: { found: false, spaceId: input.spaceId } };
}

export function presentSpace(space: Space): GetResult {
  return { found: true, space: summarizeSpace(space) };
}

const OPEN_ACCESS_NOTE =
  'Readable by every Space session on this daemon: discovery is the one Space read that cannot gate on the caller Space, because the Space is what the caller is looking for. An agent scoped to one Space can therefore see that the others exist. Sessions outside any Space are refused. Only names and lifecycle state are exposed, never Space instructions, workspaces, or configuration.';

const LIST_DESCRIPTION =
  'List the Spaces on this daemon, most recently updated first, as id, slug, name, status, paused and stopped. Start here when you need a spaceId for a Space-scoped operation and do not have one. Archived Spaces are excluded unless includeArchived is true. ' +
  OPEN_ACCESS_NOTE;

const GET_DESCRIPTION =
  'Get one Space by id as id, slug, name, status, paused and stopped. Returns { found: false, spaceId } when no Space has that id, including archived ones. ' +
  OPEN_ACCESS_NOTE;

export function createSpaceReadOperations(deps: SpaceReadDependencies): OperationDefinition[] {
  const listSpaces = (superpipe({ deps })('space-list') as PipelineAPI)
    .input(['input'])
    .pipe(readSpaceListing, ['input', 'deps'], 'spaces')
    .pipe(summarizeSpaceListing, 'spaces', 'listing')
    .endAsync('listing') as (input: ListInput) => Promise<ListResult>;

  const getSpace = (superpipe({ deps })('space-get') as PipelineAPI)
    .input(['input'])
    .pipe(findSpaceById, ['input', 'deps'], 'result:outcome')
    .pipe(presentSpace, 'outcome', 'outcome')
    .endAsync('outcome') as (input: GetInput) => Promise<GetResult>;

  return [
    defineOperation({
      name: 'space.list',
      policy: SPACE_DISCOVERY_POLICY,
      description: LIST_DESCRIPTION,
      inputSchema: ListInputSchema,
      resultSchema: ListResultSchema,
      execute: (input, caller) =>
        isOutsideSpace(caller) ? Promise.resolve(OUTSIDE_SPACE) : listSpaces(input),
    }),
    defineOperation({
      name: 'space.get',
      policy: SPACE_DISCOVERY_POLICY,
      description: GET_DESCRIPTION,
      inputSchema: GetInputSchema,
      resultSchema: GetResultSchema,
      execute: (input, caller) =>
        isOutsideSpace(caller) ? Promise.resolve(OUTSIDE_SPACE) : getSpace(input),
    }),
  ];
}
