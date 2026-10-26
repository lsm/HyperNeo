import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';

const Schema = z.object({
  pack: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[a-z][a-z0-9-]*$/),
  parameters: z.record(z.string(), z.json()),
  sandbox: z.boolean().optional(),
});
const RefusalSchema = z.enum(['unsupported_preparation', 'preparation_failed']);
type Request = z.infer<typeof Schema>;
type Failure = { ok: false; reason: z.infer<typeof RefusalSchema>; detail: string };
type Gate<T> = { value: T } | { reason: Failure };
type Location = { directory: string; destination: string };
type Prepared = { directory: string; release: () => Promise<void> };
type Effects = {
  run: (
    command: readonly string[],
    directory: string
  ) => Promise<{ code: number; stdout: string; stderr: string }>;
};

export type WorkExecutionPreparation = (
  request: Location & { parameters: Readonly<Record<string, unknown>> },
  effects: Effects
) => Promise<{ ok: true; value: Prepared } | { ok: false; reason: string }>;

type Registration = { id: string; prepareExecution?: WorkExecutionPreparation };

function admit(request: Request | undefined, supported: boolean): Gate<Request | undefined> {
  return !request || supported
    ? { value: request }
    : {
        reason: {
          ok: false,
          reason: 'unsupported_preparation',
          detail:
            'This route cannot prepare an execution location. Choose a supported local adapter.',
        },
      };
}

function selectStage(
  request: Request,
  registrations: readonly Registration[]
): Gate<WorkExecutionPreparation> {
  const matching = registrations.filter((entry) => entry.id === request.pack);
  return matching.length === 1 && matching[0].prepareExecution
    ? { value: matching[0].prepareExecution }
    : {
        reason: {
          ok: false,
          reason: 'unsupported_preparation',
          detail: `Pack ${request.pack} has no unique loaded preparation stage.`,
        },
      };
}

const prepare = (superpipe({})('work-start-preparation') as PipelineAPI)
  .input(['request', 'location', 'registrations', 'effects'])
  .pipe(selectStage, ['request', 'registrations'], 'result:prepared')
  .pipe(
    async (
      stage: WorkExecutionPreparation,
      request: Request,
      location: Location,
      effects: Effects
    ): Promise<Gate<Prepared>> => {
      const result = await stage({ ...location, parameters: request.parameters }, effects);
      return result.ok
        ? { value: result.value }
        : {
            reason: {
              ok: false,
              reason: 'preparation_failed',
              detail: `${request.pack}: ${result.reason}`,
            },
          };
    },
    ['prepared', 'request', 'location', 'effects'],
    'result:prepared'
  )
  .pipe((prepared: Prepared) => ({ ok: true, value: prepared }), 'prepared', 'prepared')
  .endAsync('prepared') as (
  request: Request,
  location: Location,
  registrations: readonly Registration[],
  effects: Effects
) => Promise<{ ok: true; value: Prepared } | Failure>;

export type WorkExecutionPreparer = (
  request: Request,
  location: Location
) => ReturnType<typeof prepare>;

export const workStartPreparation = {
  schema: Schema,
  refusalSchema: RefusalSchema,
  admit,
  prepare,
};
