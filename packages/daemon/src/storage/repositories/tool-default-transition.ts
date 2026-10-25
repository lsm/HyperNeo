import type { SessionToolChoiceKey } from '@hyperneo/shared/types/session-tool-choice';
import { defineDbOp } from '../db-gateway/db-op.ts';
import type { SkillRepository } from './skill-repository.ts';
import type { AppMcpServerRepository } from './app-mcp-server-repository.ts';

type Calls<R, K extends keyof R> = {
  [M in K]: R[M] extends (...args: infer A) => unknown ? { method: M; args: A } : never;
}[K];
export type ToolDefaultMutation =
  | ({ repository: 'skills' } & Calls<
      SkillRepository,
      'insert' | 'update' | 'delete' | 'setEnabled' | 'setValidationStatus'
    >)
  | ({ repository: 'registry' } & Calls<AppMcpServerRepository, 'create' | 'update' | 'delete'>)
  | { repository: 'overrides'; method: 'setOverride'; args: ['space', string, string, boolean] }
  | { repository: 'overrides'; method: 'clearOverride'; args: ['space', string, string] };
export interface ToolDefaultTransition {
  spaceId?: string;
  mutations: ToolDefaultMutation[];
  edits: Array<{ key: SessionToolChoiceKey; selected: boolean | null }>;
}
export const toolDefaultTransitions = defineDbOp({
  name: 'tool_defaults.transition',
  mode: 'write',
  run: (
    _db,
    _args: ToolDefaultTransition,
    _changes
  ): { ok: boolean; reason?: string; results?: unknown[] } => ({
    ok: false,
    reason: 'not_implemented',
  }),
});
