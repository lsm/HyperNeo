import { defineRepositoryOp } from '../db-gateway/db-op.ts';
import { SessionRepository } from './session-repository.ts';

export const healthSessionCountReads = defineRepositoryOp(
  'sessions.healthCount.read',
  'read',
  SessionRepository,
  ['countHumanSessions'] as const
);
