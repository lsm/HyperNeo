import { z } from 'zod';

const PermissionRequest = z.object({
  toolCall: z.object({
    kind: z.literal('execute'),
    rawInput: z.object({ CommandLine: z.string() }),
  }),
  options: z.array(z.object({ optionId: z.string(), kind: z.string() })),
});

const REPLY_COMMAND = /^hyperneo send [^;&|`$<>(){}\\\r\n]+$/;

export function antigravityPermissionOutcome(params: unknown) {
  const request = PermissionRequest.safeParse(params);
  const allow = request.success
    ? request.data.options.find((option) => option.kind === 'allow_once')
    : undefined;
  return request.success && allow && REPLY_COMMAND.test(request.data.toolCall.rawInput.CommandLine)
    ? { outcome: { outcome: 'selected', optionId: allow.optionId } }
    : { outcome: { outcome: 'cancelled' } };
}
