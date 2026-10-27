import type {
  SessionToolApplication,
  SessionToolChoiceKey,
} from '@hyperneo/shared/types/session-tool-choice';
import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import type { AgentSession } from '../agent/agent-session.ts';
import { defineOperation } from '../operations/registry.ts';
import type { SessionToolChoiceChangeResult } from './change-session-tool-choice.ts';
import type { SessionToolPreferenceWriter } from './write-session-tool-preferences.ts';

interface Dependencies {
  write: SessionToolPreferenceWriter;
  getLiveSession: (id: string) => Pick<AgentSession, 'applyToolChoice'> | null;
  exclusive: <T>(id: string, run: () => Promise<T>) => Promise<T>;
}
const Input = z.object({
  sessionId: z.string().min(1),
  key: z
    .string()
    .regex(/^(skill|mcp):.+$/)
    .meta({ examples: ['skill:example'] }) as z.ZodType<SessionToolChoiceKey>,
  selected: z.boolean(),
});
type Input = z.infer<typeof Input>;
type Saved = Extract<SessionToolChoiceChangeResult, { ok: true }>;
type Failure = Extract<SessionToolChoiceChangeResult, { ok: false }>;
type Result = Failure | ({ ok: true; changed: boolean } & SessionToolApplication);
async function persist(input: Input, deps: Dependencies) {
  const result = await deps.write(input.sessionId, {
    kind: 'choice',
    key: input.key,
    selected: input.selected,
  });
  return result.ok ? { value: result } : { reason: result };
}
async function apply(input: Input, saved: Saved, deps: Dependencies): Promise<Result> {
  const application = (await deps.getLiveSession(input.sessionId)?.applyToolChoice(input.key)) ?? {
    application: 'next_query' as const,
  };
  return { ok: true, changed: saved.changed, ...application };
}
const activate = (superpipe({})('activate-session-tool-choice') as PipelineAPI)
  .input(['input', 'deps'])
  .pipe(persist, ['input', 'deps'], 'result:activation')
  .pipe(apply, ['input', 'activation', 'deps'], 'activation')
  .endAsync('activation') as (input: Input, deps: Dependencies) => Promise<Result>;
export function createSessionToolActivationOperation(deps: Dependencies) {
  return defineOperation({
    name: 'session.tools.setChoice',
    policy: { safetyClass: 'human_only', caller: 'local_user' },
    description:
      'Save one tool choice for this session and apply supported MCP changes to its current query. Return observed application status or an explicit restart requirement. Never interrupt automatically; ACP attachment is unverified.',
    inputSchema: Input,
    resultSchema: z.union([
      z.object({ ok: z.literal(false), reason: z.string() }),
      z.object({
        ok: z.literal(true),
        changed: z.boolean(),
        application: z.enum(['live', 'next_query', 'restart_required', 'unverified']),
        reason: z.string().optional(),
      }),
    ]),
    execute: (input) => deps.exclusive(input.sessionId, () => activate(input, deps)),
  });
}
