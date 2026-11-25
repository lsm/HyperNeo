import { z } from 'zod';
import { replyCommandPermission } from './reply-command-permission.ts';

const PermissionRequest = z.object({
  toolCall: z.object({
    kind: z.literal('execute'),
    rawInput: z.object({ CommandLine: z.string() }),
  }),
  options: z.array(z.object({ optionId: z.string(), kind: z.string() })),
});

export function antigravityPermissionOutcome(params: unknown) {
  const request = PermissionRequest.safeParse(params);
  return request.success
    ? replyCommandPermission(request.data.options, request.data.toolCall.rawInput.CommandLine)
    : { outcome: { outcome: 'cancelled' } };
}
