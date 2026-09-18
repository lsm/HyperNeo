import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import { defineOperation, type OperationCaller } from '../operations/registry.ts';
import {
  admitEventCallerSpace,
  callerSessionActiveIn,
  type EventCallerDependencies,
  NODE_EVENT_ROLES,
} from './operation-admission.ts';

const inputSchema = z.object({ reason: z.string().optional() }).strict();
type Input = z.infer<typeof inputSchema>;

const REJECTIONS = z.enum(['caller_denied', 'session_inactive']);
type Rejection = z.infer<typeof REJECTIONS>;
type Result = { reattached: boolean; sessionId: string; message: string } | Rejection;

export interface NodeAgentRestoreDependencies extends EventCallerDependencies {
  restoreNodeAgent: (sessionId: string, reason?: string) => Promise<boolean>;
}

export function admitRestoreCaller(
  input: Input,
  caller: OperationCaller,
  agents: NodeAgentRestoreDependencies
): { value: string } | { reason: Rejection } {
  const space = admitEventCallerSpace({}, caller);
  if ('reason' in space || !caller.sessionId) return { reason: 'caller_denied' };
  return callerSessionActiveIn(caller, space.value, agents)
    ? { value: caller.sessionId }
    : { reason: 'session_inactive' };
}

export async function applyRestore(
  sessionId: string,
  input: Input,
  agents: NodeAgentRestoreDependencies
): Promise<Result> {
  const reattached = await agents.restoreNodeAgent(sessionId, input.reason?.trim());
  return {
    reattached,
    sessionId,
    message: reattached
      ? 'node-agent MCP server re-attached and the query restarted; retry the failed tool call in the next turn.'
      : 'the node-agent MCP server was not re-attached — either no live session remains for this worker, or the re-attach itself failed; check the daemon log for this session before retrying.',
  };
}

const RESTORE_DESCRIPTION =
  'Self-heal: re-attach the node-agent MCP server for the calling worker session and restart its query so the restored tool surface takes effect. The current turn is interrupted, so retry the failed call afterwards. The session is taken from the caller, never from input. Rejects caller_denied when the caller carries no Space and session_inactive when that session is not active in its Space; a call that cannot re-attach returns reattached: false rather than failing, and that covers both a session that already ended and a re-attach that failed, so read the message rather than assuming the session is gone.';

export function createNodeAgentRestoreOperation(agents: NodeAgentRestoreDependencies) {
  const restore = (superpipe({ agents })('restore-node-agent') as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(admitRestoreCaller, ['input', 'caller', 'agents'], 'result:outcome')
    .pipe(applyRestore, ['outcome', 'input', 'agents'], 'outcome')
    .endAsync('outcome') as (input: Input, caller: OperationCaller) => Promise<Result>;
  return defineOperation({
    name: 'nodeAgent.restore',
    description: RESTORE_DESCRIPTION,
    policy: { safetyClass: 'mutate', roles: NODE_EVENT_ROLES },
    inputSchema,
    resultSchema: z.union([
      z.object({ reattached: z.boolean(), sessionId: z.string(), message: z.string() }),
      REJECTIONS,
    ]),
    execute: async (input, caller) => restore(input, caller),
  });
}
