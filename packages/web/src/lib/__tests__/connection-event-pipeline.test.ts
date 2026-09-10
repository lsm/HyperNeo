import { describe, expect, it } from 'vitest';
import {
  applyConnectedEffects,
  applyConnectionState,
  applyReconnectAttempts,
  type ConnectionEventEffects,
  routeConnectionEvent,
  runConnectionEvent,
} from '../connection-event-pipeline';

function fixture(attempts: number | undefined = 3) {
  const calls: string[] = [];
  const effects: ConnectionEventEffects = {
    setState: (state) => {
      calls.push(`state:${state}`);
    },
    setReconnectAttempts: (count) => {
      calls.push(`attempts:${count}`);
    },
    startActions: () => {
      calls.push('start-actions');
    },
    startAudio: () => {
      calls.push('start-audio');
    },
    startTranscripts: () => {
      calls.push('start-transcripts');
    },
    stopActions: () => {
      calls.push('stop-actions');
    },
    stopAudio: () => {
      calls.push('stop-audio');
    },
    stopTranscripts: () => {
      calls.push('stop-transcripts');
    },
    closeTransport: () => {
      calls.push('close');
    },
    redirectExpiredSession: () => {
      calls.push('redirect');
    },
    notifyConnected: () => {
      calls.push('notify');
    },
    recoverAgents: () => {
      calls.push('recover');
      return new Promise<void>(() => {});
    },
    getReconnectAttempts: () => {
      calls.push('read-attempts');
      return attempts;
    },
  };
  return { effects, calls };
}

const authError = new Error('HTTP 401 Unauthorized');
const connected = [
  'state:connected',
  'attempts:0',
  'start-actions',
  'start-audio',
  'start-transcripts',
  'notify',
  'recover',
];
const auth = ['state:error', 'stop-actions', 'stop-audio', 'stop-transcripts', 'close', 'redirect'];

describe('connection event stages', () => {
  it.each([
    ['connected', authError, true, 'resume-connected'],
    ['connected', authError, false, 'normal'],
    ['error', authError, true, 'auth-error'],
    ['error', undefined, false, 'normal'],
    ['error', new Error('network unavailable'), false, 'normal'],
    ['connecting', authError, true, 'normal'],
  ] as const)('routes %s using existing precedence (case %#)', (state, error, resuming, expected) => {
    expect(routeConnectionEvent(state, error, resuming)).toBe(expected);
  });

  it('updates state before stopping services, closing transport and redirecting', () => {
    const { effects, calls } = fixture();
    applyConnectionState(effects, 'error', 'auth-error');
    expect(calls).toEqual(auth);
  });

  it('leaves state untouched for resume-connected and only notifies', () => {
    const { effects, calls } = fixture();
    applyConnectionState(effects, 'connected', 'resume-connected');
    applyConnectedEffects(effects, 'connected', 'resume-connected');
    applyReconnectAttempts(effects, 'connected', 'resume-connected');
    expect(calls).toEqual(['notify']);
  });

  it('keeps agent recovery detached from the connected callback', () => {
    const { effects, calls } = fixture();
    expect(applyConnectedEffects(effects, 'connected', 'normal')).toBeUndefined();
    expect(calls).toEqual(connected.slice(1));
  });

  it.each([0, 3, undefined])('handles transport attempt count %s', (attempts) => {
    const { effects, calls } = fixture();
    effects.getReconnectAttempts = () => {
      calls.push('read-attempts');
      return attempts;
    };
    applyReconnectAttempts(effects, 'reconnecting', 'normal');
    expect(calls).toEqual(
      attempts === undefined ? ['read-attempts'] : ['read-attempts', `attempts:${attempts}`]
    );
  });
});

describe('runConnectionEvent', () => {
  it.each([
    ['connected', undefined, false, 'normal', connected],
    ['connected', authError, true, 'resume-connected', ['notify']],
    ['error', authError, false, 'auth-error', auth],
    ['error', authError, true, 'auth-error', auth],
    ['connecting', undefined, false, 'normal', ['state:connecting', 'read-attempts', 'attempts:3']],
    [
      'reconnecting',
      undefined,
      false,
      'normal',
      ['state:reconnecting', 'read-attempts', 'attempts:3'],
    ],
    ['error', undefined, false, 'normal', ['state:error']],
    ['failed', undefined, false, 'normal', ['state:failed']],
    ['disconnected', undefined, false, 'normal', ['state:disconnected']],
  ] as const)('applies %s synchronously (case %#)', (state, error, resuming, route, expected) => {
    const { effects, calls } = fixture();
    expect(runConnectionEvent(effects, state, error, resuming)).toBe(route);
    expect(calls).toEqual(expected);
  });

  it('reads attempts after publishing state so it observes current transport state', () => {
    const { effects, calls } = fixture();
    effects.setState = () => {
      effects.getReconnectAttempts = () => 8;
    };
    runConnectionEvent(effects, 'reconnecting', undefined, false);
    expect(calls).toEqual(['attempts:8']);
  });
  it('propagates a synchronous effect failure without running later effects', () => {
    const { effects, calls } = fixture();
    const failure = new Error('stop failed');
    effects.stopAudio = () => {
      throw failure;
    };
    expect(() => runConnectionEvent(effects, 'error', authError, false)).toThrow(failure);
    expect(calls).toEqual(['state:error', 'stop-actions']);
  });
});
