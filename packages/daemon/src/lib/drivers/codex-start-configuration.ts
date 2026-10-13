import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import type { CodexAppServer } from './codex-app-server.ts';
import { workStartConfiguration } from './start-configuration.ts';
import type { Rejected, Result } from './types.ts';

type Request = z.infer<typeof workStartConfiguration.schema>;
const Page = z.object({
  data: z.array(
    z.object({
      id: z.string().min(1),
      model: z.string().min(1),
      displayName: z.string(),
      hidden: z.boolean().optional(),
      isDefault: z.boolean(),
      supportedReasoningEfforts: z.array(z.object({ reasoningEffort: z.string().min(1) })),
    })
  ),
  nextCursor: z.string().min(1).nullable(),
});
type Model = Parameters<typeof workStartConfiguration.select>[1][number];
type Gate<T> = { value: T } | { reason: Rejected };
const unavailable = (detail: string): Gate<never> => ({
  reason: { ok: false, reason: 'unreachable', detail },
});

function catalogModels(page: z.infer<typeof Page>): Model[] {
  return page.data
    .filter((model) => !model.hidden)
    .map((model) => {
      const named = /^gpt-(\d+(?:\.\d+)?)-([a-z]+)$/.exec(model.model);
      return {
        id: model.model,
        aliases: [model.id, model.displayName, ...(named ? [`${named[2]} ${named[1]}`] : [])],
        efforts: model.supportedReasoningEfforts.map((effort) => effort.reasoningEffort),
        isDefault: model.isDefault,
      };
    });
}

async function readModels(
  request: Request,
  server: Pick<CodexAppServer, 'call'>
): Promise<Gate<Model[]>> {
  if (request.model === undefined && request.effort === undefined) return { value: [] };
  const models: Model[] = [];
  const cursors = new Set<string>();
  let cursor: string | undefined;
  try {
    for (let pageNumber = 0; pageNumber < 50; pageNumber++) {
      const parsed = Page.safeParse(
        await server.call('model/list', {
          limit: 100,
          includeHidden: false,
          ...(cursor ? { cursor } : {}),
        })
      );
      if (!parsed.success) return unavailable('Codex model/list returned an unusable catalog.');
      models.push(...catalogModels(parsed.data));
      if (parsed.data.nextCursor === null) return { value: models };
      cursor = parsed.data.nextCursor;
      if (cursors.has(cursor)) return unavailable('Codex model/list repeated a pagination cursor.');
      cursors.add(cursor);
    }
    return unavailable('Codex model/list exceeded the catalog pagination limit.');
  } catch (error) {
    return unavailable(
      `Could not read Codex models: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

export const selectCodexConfiguration = (superpipe({})('codex-start-configuration') as PipelineAPI)
  .input(['request', 'server'])
  .pipe(readModels, ['request', 'server'], 'result:configuration')
  .pipe(
    (request: Request, models: Model[]): Gate<Request> => {
      const selected = workStartConfiguration.select(request, models);
      return 'ok' in selected ? { reason: selected } : { value: selected };
    },
    ['request', 'configuration'],
    'result:configuration'
  )
  .pipe(
    (configuration: Request): Result<Request> => ({ ok: true, value: configuration }),
    'configuration',
    'configuration'
  )
  .endAsync('configuration') as (
  request: Request,
  server: Pick<CodexAppServer, 'call'>
) => Promise<Result<Request>>;
