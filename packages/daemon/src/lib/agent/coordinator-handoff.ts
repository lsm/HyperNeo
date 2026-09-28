import superpipe, { type PipelineAPI } from 'superpipe';
import type { NeoBinding } from '@hyperneo/shared/types/neo-context';

export type HandoffOwnership = {
  generation: number;
  currentGeneration: number;
  interruptEpoch: number;
  currentInterruptEpoch: number;
  queryActive: boolean;
};

export type HandoffAvailability = {
  sessionStatus: string | undefined;
  queryMode: string | undefined;
  provider: string | undefined;
  processingStatus: string;
  cleaningUp: boolean;
  waiting: boolean;
  recovering: boolean;
};

type Skip = 'not_coordinator' | 'superseded' | 'unavailable' | 'no_successor';
type Admission = { value: NeoBinding } | { reason: Skip };

export function gateHandoffBinding(binding: NeoBinding | null): Admission {
  return binding && (binding.kind === 'neo' || binding.kind === 'concern')
    ? { value: binding }
    : { reason: 'not_coordinator' };
}

export function gateHandoffOwnership(binding: NeoBinding, owner: HandoffOwnership): Admission {
  return owner.generation === owner.currentGeneration &&
    owner.interruptEpoch === owner.currentInterruptEpoch &&
    !owner.queryActive
    ? { value: binding }
    : { reason: 'superseded' };
}

export function gateHandoffAvailability(
  binding: NeoBinding,
  state: HandoffAvailability
): Admission {
  return state.sessionStatus === 'active' &&
    state.queryMode !== 'manual' &&
    state.provider !== 'acp' &&
    (state.processingStatus === 'idle' || state.processingStatus === 'queued') &&
    !state.cleaningUp &&
    !state.waiting &&
    !state.recovering
    ? { value: binding }
    : { reason: 'unavailable' };
}

export function gateHandoffPending(binding: NeoBinding, hasQueued: boolean): Admission {
  return hasQueued ? { value: binding } : { reason: 'no_successor' };
}

export const decideCoordinatorHandoff = (superpipe({})('coordinator-handoff') as PipelineAPI)
  .input(['binding', 'ownership', 'availability', 'hasQueued'])
  .pipe(gateHandoffBinding, 'binding', 'result:admission')
  .pipe(gateHandoffOwnership, ['admission', 'ownership'], 'result:admission')
  .pipe(gateHandoffAvailability, ['admission', 'availability'], 'result:admission')
  .pipe(gateHandoffPending, ['admission', 'hasQueued'], 'result:admission')
  .end('admission') as (
  binding: NeoBinding | null,
  ownership: HandoffOwnership,
  availability: HandoffAvailability,
  hasQueued: boolean
) => NeoBinding | Skip;
