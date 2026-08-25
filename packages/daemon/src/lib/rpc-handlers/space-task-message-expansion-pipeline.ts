import superpipe, { type PipelineAPI } from 'superpipe';

export interface SpaceGithubEventRow {
  id: string;
  summary: string;
  external_url: string;
}

export type SpaceTaskMessageExpansionOutcome =
  | { status: 'invalidInput' }
  | { status: 'unauthorized' }
  | { status: 'notFound' }
  | { status: 'tooLarge'; messageId: string }
  | { status: 'expanded'; sdkMessage: string };

export interface SpaceTaskMessageExpansionCtx {
  taskId: string;
  messageId: string;
  findSpaceTaskScope: (taskId: string) => unknown;
  findSdkMessage: (messageId: string, taskId: string) => string | undefined;
  findGithubEvent: (messageId: string, taskId: string) => SpaceGithubEventRow | undefined;
  sdkMessage: string | null;
  outcome: SpaceTaskMessageExpansionOutcome | null;
}

export type SpaceTaskMessageExpansionInput = Omit<
  SpaceTaskMessageExpansionCtx,
  'sdkMessage' | 'outcome'
>;

const MAX_SPACE_TASK_MESSAGE_EXPANSION_BYTES = 16 * 1024 * 1024;

function settled(ctx: SpaceTaskMessageExpansionCtx): boolean {
  return ctx.outcome !== null;
}

function decide(
  ctx: SpaceTaskMessageExpansionCtx,
  outcome: SpaceTaskMessageExpansionOutcome
): SpaceTaskMessageExpansionCtx {
  return { ...ctx, outcome };
}

function gateExpansionInput(ctx: SpaceTaskMessageExpansionCtx): SpaceTaskMessageExpansionCtx {
  return ctx.taskId && ctx.messageId ? ctx : decide(ctx, { status: 'invalidInput' });
}

function gateTaskScope(ctx: SpaceTaskMessageExpansionCtx): SpaceTaskMessageExpansionCtx {
  return ctx.findSpaceTaskScope(ctx.taskId) ? ctx : decide(ctx, { status: 'unauthorized' });
}

function loadSdkMessage(ctx: SpaceTaskMessageExpansionCtx): SpaceTaskMessageExpansionCtx {
  return { ...ctx, sdkMessage: ctx.findSdkMessage(ctx.messageId, ctx.taskId) ?? null };
}

function buildGithubSyntheticUserMessage(event: SpaceGithubEventRow): string {
  return JSON.stringify({
    type: 'user',
    uuid: event.id,
    message: {
      role: 'user',
      content: [
        {
          type: 'text',
          text: `[GitHub] ${event.summary}\n${event.external_url}`,
        },
      ],
    },
  });
}

function reconstructGithubUserMessage(
  ctx: SpaceTaskMessageExpansionCtx
): SpaceTaskMessageExpansionCtx {
  if (ctx.sdkMessage !== null) return ctx;
  const githubEvent = ctx.findGithubEvent(ctx.messageId, ctx.taskId);
  return githubEvent ? { ...ctx, sdkMessage: buildGithubSyntheticUserMessage(githubEvent) } : ctx;
}

function gateMessageResolved(ctx: SpaceTaskMessageExpansionCtx): SpaceTaskMessageExpansionCtx {
  return ctx.sdkMessage !== null ? ctx : decide(ctx, { status: 'notFound' });
}

function gateExpansionSize(ctx: SpaceTaskMessageExpansionCtx): SpaceTaskMessageExpansionCtx {
  const sdkMessage = ctx.sdkMessage as string;
  if (Buffer.byteLength(sdkMessage, 'utf8') > MAX_SPACE_TASK_MESSAGE_EXPANSION_BYTES) {
    return decide(ctx, { status: 'tooLarge', messageId: ctx.messageId });
  }
  return decide(ctx, { status: 'expanded', sdkMessage });
}

const expansionPipeline = (
  superpipe<{ settled: (ctx: SpaceTaskMessageExpansionCtx) => boolean }>({
    settled,
  })('space-task-message-expansion') as PipelineAPI
)
  .input(['ctx'])
  .pipe(gateExpansionInput, 'ctx', 'ctx')
  .pipe('!settled', 'ctx')
  .pipe(gateTaskScope, 'ctx', 'ctx')
  .pipe('!settled', 'ctx')
  .pipe(loadSdkMessage, 'ctx', 'ctx')
  .pipe(reconstructGithubUserMessage, 'ctx', 'ctx')
  .pipe(gateMessageResolved, 'ctx', 'ctx')
  .pipe('!settled', 'ctx')
  .pipe(gateExpansionSize, 'ctx', 'ctx')
  .end('ctx');

const run = expansionPipeline as (input: SpaceTaskMessageExpansionCtx) => unknown;

export function runSpaceTaskMessageExpansion(
  input: SpaceTaskMessageExpansionInput
): SpaceTaskMessageExpansionOutcome {
  const ctx = run({ ...input, sdkMessage: null, outcome: null }) as SpaceTaskMessageExpansionCtx;
  return ctx.outcome as SpaceTaskMessageExpansionOutcome;
}
