import { neoToolDescription } from '@hyperneo/prompts';
import {
  PROVIDER_THINKING_MODES,
  THINKING_LEVEL_EFFORT,
  type Provider,
  type Session,
} from '@hyperneo/shared';
import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import type { Database } from '../../storage/database.ts';
import { neoTodoSessionReads } from '../../storage/repositories/neo-todo-session-repository.ts';
import { workStartedSessionReads } from '../../storage/repositories/work-started-sessions-worker.ts';
import { isNeoConversationSession } from '../neo/publication-read-operation.ts';
import { getAvailableModels, resolveSessionContextModelInfo } from '../model-service.ts';
import { defineOperation, type OperationCaller } from '../operations/registry.ts';
import { getProviderRegistry } from '../providers/registry.ts';
import { providerSessionConfigForSession } from '../providers/session-config.ts';
import { thinkingRefusal } from '../agent/session-engine.ts';
import { setSessionThinkingLevel } from '../session/runtime-settings-operations.ts';
import type { SessionManager } from '../session/session-manager.ts';
import { usableModels } from '../usable-models.ts';
import { resolveHyperneoThinking, workStartConfiguration } from './start-configuration.ts';
import { type Rejected, WorkRefSchema, workResultSchema } from './types.ts';
import { reject } from './work-operations.ts';

const InputSchema = workStartConfiguration.schema.extend({ ref: WorkRefSchema });
const Identity = z.object({ model: z.string(), effort: z.string().nullable() });
const ResultSchema = workResultSchema(
  z.object({
    ref: WorkRefSchema,
    previous: Identity,
    next: Identity,
    appliesFrom: z.enum(['next-turn', 'when-idle']),
  })
);
type Input = z.infer<typeof InputSchema>;
type Deps = {
  db: Database;
  sessions: SessionManager;
  readBinding: (id: string) => Parameters<typeof isNeoConversationSession>[1];
};
const refuse = (reason: Rejected['reason'], detail: string) => ({
  reason: reject(reason, detail),
});

async function admitTarget(
  { ref }: Input,
  caller: OperationCaller,
  { db, sessions, readBinding }: Deps
) {
  const binding = caller.sessionId && readBinding(caller.sessionId);
  if (!binding || !isNeoConversationSession(caller, binding))
    return refuse('human_only', 'This action needs a bound Neo session.');
  if (ref.adapter !== 'hyperneo' || ref.daemon)
    return refuse('not_supported', 'This driver or daemon has no supported settings switch here.');
  if (!(await db.gateway.call(workStartedSessionReads, 'startedByUs', ref)))
    return refuse('not_started_by_us', 'This session was not started by the daemon.');
  const session = sessions.getSessionFromDB(ref.id);
  if (!session || session.status !== 'active') return refuse('not_open', 'The session is closed.');
  if (
    session.metadata?.titleSetBy === 'user' ||
    (await db.gateway.call(neoTodoSessionReads, 'wasNamedByHuman', ref))
  )
    return refuse('human_only', 'Ask the person who named this session to use the chat picker.');
  return { value: session } as const;
}

async function resolveChange(session: Session, input: Input) {
  const thinking = resolveHyperneoThinking(input.effort);
  if (input.effort !== undefined && !thinking)
    return refuse('unsupported_effort', 'Use a thinking level offered by the session.');
  const refusal = thinkingRefusal(session.config.harness, thinking?.value);
  if (refusal) return refuse('unsupported_effort', refusal);
  if (input.model === undefined && thinking === undefined)
    return refuse('unsupported', 'Provide a model, an effort, or both.');

  const current = session.config;
  const models = usableModels(getAvailableModels()).filter(({ id }) => id === input.model);
  const offer = models.find(({ provider }) => provider === current.provider) ?? models[0];
  if (input.model !== undefined && !offer)
    return refuse('unsupported_model', 'Choose an available model ID.');
  const selected = offer ?? (await resolveSessionContextModelInfo(session)).modelInfo;
  const model = offer?.id ?? current.model;
  const provider = offer?.provider ?? current.provider;
  const driver = provider && getProviderRegistry().get(provider);
  if (!provider || !driver)
    return refuse('unsupported_model', 'The model provider is unavailable.');
  const config = providerSessionConfigForSession(session);
  const mode =
    driver.getModelThinkingMode?.(model, config) ??
    selected?.thinkingModes ??
    driver.capabilities?.thinkingModes ??
    PROVIDER_THINKING_MODES[provider as Provider];
  const levels = driver.getModelEffortLevels?.(model, config) ?? selected?.effortLevels;
  const effort = thinking && THINKING_LEVEL_EFFORT[thinking.value];
  if (effort && (mode === 'off' || (levels?.length && !levels.includes(effort))))
    return refuse(
      'unsupported_effort',
      `The chosen model does not support ${thinking.label} thinking.`
    );
  return { value: { model, provider, thinking } } as const;
}
type Change = Extract<Awaited<ReturnType<typeof resolveChange>>, { value: unknown }>['value'];

async function switchSettings(change: Change, input: Input, deps: Deps) {
  const agent = await deps.sessions.getSessionForControl(input.ref.id);
  if (!agent) return reject('not_found', 'The session is gone.');
  const { config, status } = agent.getSessionData();
  if (status !== 'active') return reject('not_open', 'The session is closed.');
  const { model, provider } = change;
  const previous = identity(config);
  if (!input.model && (config.model !== model || config.provider !== provider))
    return reject('not_delivered', 'The current model changed. Read status and try again.');
  const level = change.thinking?.value;
  const result =
    !input.model && level !== undefined
      ? await setSessionThinkingLevel(deps.sessions, agent, level)
      : await agent.requestModelSwitch(model, provider, undefined, level);
  if (!result.success)
    return reject('not_delivered', result.error ?? 'The settings switch failed.');
  const pending = 'pending' in result ? result.pending : undefined;
  const applied = agent.getSessionData().config;
  const next = identity({ ...applied, ...pending });
  const appliesFrom = pending ? 'when-idle' : 'next-turn';
  return { ok: true, value: { ref: input.ref, previous, next, appliesFrom } } as const;
}

function identity({ model, thinkingLevel }: Pick<Session['config'], 'model' | 'thinkingLevel'>) {
  return { model, effort: resolveHyperneoThinking(thinkingLevel)?.label.toLowerCase() ?? null };
}

const runReconfigure = (superpipe({})('work.reconfigure') as PipelineAPI)
  .input(['input', 'caller', 'deps'])
  .pipe(admitTarget, ['input', 'caller', 'deps'], 'result:outcome')
  .pipe(resolveChange, ['outcome', 'input'], 'result:outcome')
  .pipe(switchSettings, ['outcome', 'input', 'deps'], 'outcome')
  .endAsync('outcome') as RunReconfigure;

type RunReconfigure = (
  input: Input,
  caller: OperationCaller,
  deps: Deps
) => Promise<z.infer<typeof ResultSchema>>;

export function createWorkReconfigureOperation(deps: Deps) {
  return defineOperation({
    name: 'work.reconfigure',
    description: neoToolDescription('work.reconfigure'),
    inputSchema: InputSchema,
    resultSchema: ResultSchema,
    policy: { safetyClass: 'mutate', roles: ['neo'] },
    execute: (input, caller) => runReconfigure(input, caller, deps),
  });
}
