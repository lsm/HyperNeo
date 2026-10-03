import type { Session } from '@hyperneo/shared';
import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import { defineOperation, type OperationCaller } from '../operations/registry.ts';

const InputSchema = z
  .object({ sessionId: z.string().min(1), parentSessionId: z.string().min(1).nullable() })
  .strict();

const REJECTIONS = [
  'caller_denied',
  'session_not_found',
  'parent_not_found',
  'self_parent',
  'parent_is_child',
  'has_children',
  'unsupported_session',
] as const;

type Input = z.infer<typeof InputSchema>;
type Rejection = { accepted: false; reason: (typeof REJECTIONS)[number]; message: string };
type Result = { accepted: true; sessionId: string; parentSessionId: string | null } | Rejection;
type Gate<T> = { value: T } | { reason: Rejection };
type Move = { session: Session; parent: Session | null };

const ResultSchema = z.union([
  z
    .object({
      accepted: z.literal(true),
      sessionId: z.string(),
      parentSessionId: z.string().nullable(),
    })
    .strict(),
  z
    .object({ accepted: z.literal(false), reason: z.enum(REJECTIONS), message: z.string() })
    .strict(),
]);

export interface SetSessionParentDependencies {
  readonly getSession: (sessionId: string) => Session | null;
  readonly listChildren: (sessionId: string) => Session[];
  readonly sessionSpaceId: (session: Session) => string | undefined;
  readonly setParent: (sessionId: string, parentId: string | null) => void;
}

function reject(reason: Rejection['reason'], message: string): { reason: Rejection } {
  return { reason: { accepted: false, reason, message } };
}

export function requireHumanCaller(caller: OperationCaller): Gate<OperationCaller> {
  return caller.source === 'rpc'
    ? { value: caller }
    : reject('caller_denied', 'Only a person can move sessions');
}

export function loadMove(input: Input, deps: SetSessionParentDependencies): Gate<Move> {
  const session = deps.getSession(input.sessionId);
  if (!session || session.status === 'archived')
    return reject('session_not_found', 'Session not found');
  if (input.parentSessionId === null) return { value: { session, parent: null } };
  if (input.parentSessionId === session.id)
    return reject('self_parent', 'A session cannot be its own parent');
  const parent = deps.getSession(input.parentSessionId);
  if (!parent || parent.status === 'archived')
    return reject('parent_not_found', 'Parent session not found');
  return { value: { session, parent } };
}

export function requirePlainSessions(move: Move, deps: SetSessionParentDependencies): Gate<Move> {
  const special = (session: Session) =>
    session.id.startsWith('neo:') || deps.sessionSpaceId(session) !== undefined;
  return special(move.session) || (move.parent !== null && special(move.parent))
    ? reject('unsupported_session', 'Neo and Space sessions keep their own structure')
    : { value: move };
}

export function requireOneLevel(move: Move, deps: SetSessionParentDependencies): Gate<Move> {
  if (!move.parent) return { value: move };
  if (move.parent.parentSessionId)
    return reject('parent_is_child', 'The parent is itself a child session');
  if (deps.listChildren(move.session.id).length > 0)
    return reject('has_children', 'A session with children cannot become a child');
  return { value: move };
}

function applyMove(move: Move, deps: SetSessionParentDependencies): Result {
  const parentSessionId = move.parent?.id ?? null;
  deps.setParent(move.session.id, parentSessionId);
  return { accepted: true, sessionId: move.session.id, parentSessionId };
}

const setParent = (superpipe({})('session-parent-set') as PipelineAPI)
  .input(['input', 'caller', 'deps'])
  .pipe(requireHumanCaller, 'caller', 'result:move')
  .pipe(loadMove, ['input', 'deps'], 'result:move')
  .pipe(requirePlainSessions, ['move', 'deps'], 'result:move')
  .pipe(requireOneLevel, ['move', 'deps'], 'result:move')
  .pipe(applyMove, ['move', 'deps'], 'move')
  .end('move') as (
  input: Input,
  caller: OperationCaller,
  deps: SetSessionParentDependencies
) => Result;

export function createSetSessionParentOperation(deps: SetSessionParentDependencies) {
  return defineOperation({
    name: 'session.parent.set',
    description:
      'Move a session under another top-level session, or back to the top level with a null parentSessionId. One level deep only; Neo and Space sessions are not movable. Rejects caller_denied, session_not_found, parent_not_found, self_parent, parent_is_child, has_children and unsupported_session.',
    inputSchema: InputSchema,
    resultSchema: ResultSchema,
    execute: async (input, caller) => setParent(input, caller, deps),
  });
}
