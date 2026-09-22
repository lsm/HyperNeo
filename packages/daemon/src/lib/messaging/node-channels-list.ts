import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import { defineOperation, type OperationCaller } from '../operations/registry.ts';
import {
  admitNodeCaller,
  type NodeMessagingContext,
  type NodeMessagingDependencies,
  NodeContextRejectionSchema,
  resolveNodeContext,
} from './node-messaging-context.ts';

const inputSchema = z.object({}).strict();

type Input = z.infer<typeof inputSchema>;

const ChannelSchema = z.object({
  channelId: z.string().nullable(),
  from: z.string(),
  to: z.union([z.string(), z.array(z.string())]),
  maxCycles: z.number().nullable(),
  label: z.string().nullable(),
});

const ChannelsPageSchema = z.object({
  channels: z.array(ChannelSchema),
  total: z.number().int().min(0),
  message: z.string(),
});

const resultSchema = z.union([ChannelsPageSchema, NodeContextRejectionSchema]);

type Result = z.infer<typeof resultSchema>;

export function listNodeChannels(context: NodeMessagingContext): Result {
  const { workflow } = context.runtime;
  const channels = workflow?.channels ?? [];
  const result = channels.map((channel) => ({
    channelId: channel.id ?? null,
    from: channel.from,
    to: channel.to,
    maxCycles: channel.maxCycles ?? null,
    label: channel.label ?? null,
  }));
  return {
    channels: result,
    total: result.length,
    message: `Found ${result.length} channel(s) in workflow "${workflow?.name ?? 'unknown'}".`,
  };
}

const LIST_CHANNELS_DESCRIPTION =
  'List the channels declared in this workflow — the full messaging topology. The calling node-agent session identifies the workflow run; only workflow worker sessions are admitted. Rejects not_a_node_agent when the caller is not a live node-agent session and node_caller_denied when the caller is not a workflow worker or belongs to another Space.';

export function createListNodeChannelsOperation(deps: NodeMessagingDependencies) {
  const run = (superpipe({ deps })('list-node-channels') as PipelineAPI)
    .input(['caller'])
    .pipe(admitNodeCaller, 'caller', 'result:outcome')
    .pipe(resolveNodeContext, ['outcome', 'caller', 'deps'], 'result:outcome')
    .pipe(listNodeChannels, 'outcome', 'outcome')
    .endAsync('outcome') as (caller: OperationCaller) => Promise<Result>;
  return defineOperation({
    name: 'workflow.run.channel.list',
    policy: { safetyClass: 'read', roles: ['workflow_worker'] },
    description: LIST_CHANNELS_DESCRIPTION,
    inputSchema,
    resultSchema,
    execute: (_input: Input, caller) => run(caller),
  });
}
