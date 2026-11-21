import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import { defineOperation, type OperationCaller } from '../operations/registry.ts';
import { SESSION_DOOR_PRINCIPAL } from '../pairing/pairing-operations.ts';
import type { createCodexSetup } from './codex-setup.ts';

const Input = z
  .strictObject({ undo: z.boolean().optional(), noRemoteControl: z.boolean().optional() })
  .refine((input) => !(input.undo && input.noRemoteControl));
const Result = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(false), reason: z.string() }),
  z.object({ ok: z.literal(true), message: z.string(), removed: z.array(z.string()).optional() }),
]);

export function createCodexSetupOperation(setup: ReturnType<typeof createCodexSetup> | undefined) {
  const runCodexSetup = (superpipe({})('system.codex.setup') as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(
      (caller: OperationCaller) => {
        if (
          caller.source !== 'mcp' ||
          caller.principal !== SESSION_DOOR_PRINCIPAL ||
          caller.device?.kind !== 'human'
        )
          return { reason: { ok: false, reason: 'Use the local hyperneo codex-setup command.' } };
        return setup
          ? { value: setup }
          : { reason: { ok: false, reason: 'Codex setup requires macOS.' } };
      },
      'caller',
      'result:setup'
    )
    .pipe(
      (runtime: NonNullable<typeof setup>, request: z.infer<typeof Input>) =>
        runtime.manual(request),
      ['setup', 'input'],
      'setup'
    )
    .endAsync('setup');
  return defineOperation({
    name: 'system.codex.setup',
    description: 'Configure or undo the shared Codex app server from the local command.',
    inputSchema: Input,
    resultSchema: Result,
    policy: { safetyClass: 'human_only' },
    execute: async (input, caller) => runCodexSetup(input, caller),
  });
}
