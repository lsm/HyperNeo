import { z } from 'zod';
import type { ProcessJsonRpcTransport } from '../process-json-rpc.ts';
import { workStartConfiguration } from './start-configuration.ts';
import type { Result, StartRequest } from './types.ts';
import { reject } from './work-operations.ts';

const Value = z.object({ value: z.string().min(1) });
const Select = z.object({
  id: z.string().min(1),
  category: z.string().nullish(),
  type: z.literal('select'),
  currentValue: z.string().min(1),
  options: z.array(z.union([Value, z.object({ options: z.array(Value) })])),
});
export const AntigravityConfig = z.object({ configOptions: z.array(z.unknown()).nullish() });
type Settings = Pick<StartRequest, 'model' | 'effort'>;
type Options = z.infer<typeof AntigravityConfig>['configOptions'];
const categories = { model: 'model', effort: 'thought_level' } as const;

function readOption(options: Options, field: keyof Settings) {
  for (const entry of options ?? []) {
    const parsed = Select.safeParse(entry);
    if (parsed.success && (parsed.data.category ?? parsed.data.id) === categories[field])
      return parsed.data;
  }
}

export function antigravityIdentity(options: Options): Settings {
  const model = readOption(options, 'model')?.currentValue;
  const effort = readOption(options, 'effort')?.currentValue;
  return { ...(model ? { model } : {}), ...(effort ? { effort } : {}) };
}

function availableValue(option: z.infer<typeof Select>, requested: string): string | undefined {
  if (requested === option.currentValue) return requested;
  const values = option.options.flatMap((entry) => ('value' in entry ? [entry] : entry.options));
  const exact = values.find(({ value }) => value === requested);
  if (exact) return exact.value;
  const matches = new Set(
    [option.currentValue, ...values.map(({ value }) => value)].filter(
      (value) =>
        workStartConfiguration.normalize(value) === workStartConfiguration.normalize(requested)
    )
  );
  return matches.size === 1 ? matches.values().next().value : undefined;
}

export async function configureAntigravity(
  transport: ProcessJsonRpcTransport,
  sessionId: string,
  initial: Options,
  request: Settings
): Promise<Result<Options>> {
  let options = initial;
  const requested: Settings = {};
  for (const field of ['model', 'effort'] as const) {
    const choice = request[field];
    if (choice === undefined) continue;
    const option = readOption(options, field);
    const value = option && availableValue(option, choice);
    if (!option || !value) {
      return reject(
        field === 'model' ? 'unsupported_model' : 'unsupported_effort',
        `Antigravity does not offer the requested ${field} for this session.`,
        true
      );
    }
    requested[field] = value;
    if (option.currentValue === value) continue;
    const response = await transport.sendRequest('session/set_config_option', {
      sessionId,
      configId: option.id,
      value,
    });
    const settings = AntigravityConfig.safeParse(
      'result' in response ? response.result : undefined
    );
    if (!settings.success || readOption(settings.data.configOptions, field)?.currentValue !== value)
      return reject('not_delivered', `Antigravity did not confirm the requested ${field}.`, true);
    options = settings.data.configOptions;
  }
  const confirmed = workStartConfiguration.confirm(requested, antigravityIdentity(options));
  return confirmed.ok ? { ok: true, value: options } : { ...confirmed, notSent: true };
}
