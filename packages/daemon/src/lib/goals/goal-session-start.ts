import type { Session } from '@hyperneo/shared';
import {
  buildCloneParams,
  type SpawnSessionCloneDependencies,
} from '../session/clone-operations.ts';

type Deps = Pick<
  SpawnSessionCloneDependencies,
  'isGitRepo' | 'createSession' | 'addSpaceSession' | 'attachSpaceTools'
>;

export async function startGoalSession(parent: Session, title: string, deps: Deps) {
  const params = await buildCloneParams(parent, { title }, deps);
  const { model, provider, thinkingLevel } = parent.config;
  const sessionId = await deps.createSession({
    ...params,
    toolProfile: undefined,
    promptProvenance: undefined,
    config: Object.fromEntries(
      Object.entries({ model, provider, thinkingLevel }).filter(([, value]) => value !== undefined)
    ),
  });
  if (params.spaceId) {
    await deps.addSpaceSession(params.spaceId, sessionId);
    await deps.attachSpaceTools(sessionId);
  }
  return sessionId;
}
