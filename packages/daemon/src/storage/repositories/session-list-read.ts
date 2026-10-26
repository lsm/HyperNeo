import { defineRepositoryOp } from '../db-gateway/db-op.ts';
import { SessionRepository } from './session-repository.ts';

export const sessionListReads = defineRepositoryOp(
  'sessions.list.read',
  'read',
  SessionRepository,
  ['listSessions'] as const
);
