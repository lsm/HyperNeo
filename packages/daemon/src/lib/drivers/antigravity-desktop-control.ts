import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  ANTIGRAVITY_DESKTOP_UNAVAILABLE,
  callAntigravityDesktop,
  readAntigravityDesktopEndpoint,
} from './antigravity-desktop-channel.ts';
import type { AntigravityDesktopSession } from './antigravity-desktop-discovery.ts';
import type { Result, WorkAdapter, WorkDelivery } from './types.ts';
import { reject } from './work-operations.ts';

const Id = z.string().regex(/^[\w-]{1,128}$/);
const Steps = z.object({
  steps: z
    .array(
      z.looseObject({
        type: z.string(),
        status: z.string(),
        userInput: z.looseObject({ userResponse: z.string().optional() }).optional(),
      })
    )
    .default([]),
});
const Accepted = z.looseObject({});
const WORKING = new Set(['CORTEX_STEP_STATUS_GENERATING', 'CORTEX_STEP_STATUS_RUNNING']);
const CONFIRM_MS = 5_000;
const POLL_MS = 250;

type Deps = {
  homeDir: string;
  find: (id: string) => Promise<AntigravityDesktopSession | undefined>;
  now?: () => number;
  wait?: (ms: number) => Promise<void>;
};

export function createAntigravityDesktopControl(deps: Deps): Required<Pick<WorkAdapter, 'send'>> {
  const now = deps.now ?? Date.now;
  const wait = deps.wait ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  return {
    async send(ref, message): Promise<Result<WorkDelivery>> {
      const session = Id.safeParse(ref.id).success ? await deps.find(ref.id) : undefined;
      if (session?.id !== ref.id)
        return reject('not_found', 'Antigravity Desktop conversation not found.', true);
      const endpoint = readAntigravityDesktopEndpoint(deps.homeDir);
      if (!endpoint) return reject('unreachable', ANTIGRAVITY_DESKTOP_UNAVAILABLE, true);
      const steps = () =>
        callAntigravityDesktop(endpoint, 'GetCascadeTrajectorySteps', { cascadeId: ref.id }, Steps);
      const before = await steps();
      if (!before.ok) return { ...before, notSent: true };
      if (WORKING.has(before.value.steps.at(-1)?.status ?? ''))
        return reject(
          'busy',
          'Antigravity Desktop is still working on this conversation. Stop it or wait for the turn to end.',
          true
        );
      const clientMessageId = randomUUID();
      const sent = await callAntigravityDesktop(
        endpoint,
        'SendUserCascadeMessage',
        { cascadeId: ref.id, items: [{ text: message }], clientMessageId },
        Accepted
      );
      if (!sent.ok) return { ...sent, clientMessageId };
      const receipt = { executionId: ref.id, inputId: clientMessageId };
      const deadline = now() + CONFIRM_MS;
      do {
        await wait(POLL_MS);
        const after = await steps();
        if (
          after.ok &&
          after.value.steps
            .slice(before.value.steps.length)
            .some(
              (step) =>
                step.type === 'CORTEX_STEP_TYPE_USER_INPUT' &&
                step.userInput?.userResponse === message
            )
        )
          return { ok: true, value: { delivered: true, receipt, confirmedAt: now() } };
      } while (now() < deadline);
      return { ok: true, value: { delivered: false, unconfirmed: true, receipt } };
    },
  };
}
