import { createDefaultConnectionEventEffects } from './connection-event-adapter';
import { createDefaultConnectionResumeEffects } from './connection-resume-adapter';
import { createDefaultConnectionLifecycleEffects } from './connection-lifecycle-adapter';
import { markAllSessionStoresRecovering } from './session-store';

export interface ConnectionApplication {
  lifecycle: ReturnType<typeof createDefaultConnectionLifecycleEffects>;
  createEventEffects: typeof createDefaultConnectionEventEffects;
  createResumeEffects: typeof createDefaultConnectionResumeEffects;
  markSessionsRecovering(): void;
}

export function createDefaultConnectionApplication(): ConnectionApplication {
  return {
    lifecycle: createDefaultConnectionLifecycleEffects(),
    createEventEffects: createDefaultConnectionEventEffects,
    createResumeEffects: createDefaultConnectionResumeEffects,
    markSessionsRecovering: () => markAllSessionStoresRecovering(),
  };
}
