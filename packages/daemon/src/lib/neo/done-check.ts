import type { NeoAsk } from '@hyperneo/shared/types/neo-snapshot';

export const isNeoAskSettled = (ask: Pick<NeoAsk, 'status'>) =>
  ask.status === 'achieved' || ask.status === 'abandoned';

export const isNeoAskLive = (ask: Pick<NeoAsk, 'status'> | null) => !!ask && !isNeoAskSettled(ask);
