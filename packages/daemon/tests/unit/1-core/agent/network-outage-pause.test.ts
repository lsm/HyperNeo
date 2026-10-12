import { describe, expect, test } from 'bun:test';
import {
  isNetworkUnreachableError,
  NETWORK_OUTAGE_NOTICE,
  NETWORK_OUTAGE_POPUP_AFTER_MS,
  NETWORK_PROBE_EVERY_MS,
  NetworkOutagePause,
  networkProbeHost,
  planNetworkOutageTick,
  providerProbeHost,
} from '../../../../src/lib/agent/network-outage-pause';
import { resultNetworkOutage } from '../../../../src/lib/agent/sdk-message-handler';
import type { SDKMessage } from '@hyperneo/shared/sdk';

describe('isNetworkUnreachableError', () => {
  test('recognises unreachable-network failures from the provider or a bridge upstream', () => {
    for (const text of [
      'API Error: 502 {"error":{"message":"getaddrinfo ENOTFOUND chatgpt.com"}}',
      'connect ECONNREFUSED 10.0.0.5:443',
      'request to https://api.anthropic.com failed, reason: ETIMEDOUT',
      'connect ENETUNREACH 2606:4700::1:443',
      'API Error: Connection error.',
    ])
      expect(isNetworkUnreachableError(text)).toBe(true);
  });

  test('leaves provider, auth and process failures alone', () => {
    for (const text of [
      'invalid_api_key',
      '429 Too Many Requests',
      'Claude Code process exited with code 1',
      'overloaded_error',
      'backend connection error',
    ])
      expect(isNetworkUnreachableError(text)).toBe(false);
  });
});

describe('networkProbeHost', () => {
  test('probes the host the failure names, else the Anthropic API', () => {
    expect(networkProbeHost('getaddrinfo ENOTFOUND chatgpt.com')).toBe('chatgpt.com');
    expect(networkProbeHost('connect ECONNREFUSED 10.0.0.5:443')).toBe('10.0.0.5');
    expect(networkProbeHost('API Error: Connection error.')).toBe('api.anthropic.com');
    expect(networkProbeHost('connect ENETUNREACH 2606:4700::1:443')).toBe('api.anthropic.com');
    expect(networkProbeHost('API Error: Connection error.', 'open.bigmodel.cn')).toBe(
      'open.bigmodel.cn'
    );
  });
});

describe('providerProbeHost', () => {
  test('takes the provider host from its base URL, but never a local bridge', () => {
    expect(providerProbeHost('https://open.bigmodel.cn/api/anthropic')).toBe('open.bigmodel.cn');
    expect(providerProbeHost('http://127.0.0.1:51234')).toBeNull();
    expect(providerProbeHost('http://localhost:8080')).toBeNull();
    expect(providerProbeHost(undefined)).toBeNull();
  });
});

describe('planNetworkOutageTick', () => {
  test('raises the popup once, only after the long threshold', () => {
    expect(planNetworkOutageTick(0, NETWORK_OUTAGE_POPUP_AFTER_MS - 1, false).popup).toBe(false);
    expect(planNetworkOutageTick(0, NETWORK_OUTAGE_POPUP_AFTER_MS, false)).toEqual({
      popup: true,
      nextProbeAt: NETWORK_OUTAGE_POPUP_AFTER_MS + NETWORK_PROBE_EVERY_MS,
    });
    expect(planNetworkOutageTick(0, NETWORK_OUTAGE_POPUP_AFTER_MS, true).popup).toBe(false);
  });
});

describe('resultNetworkOutage', () => {
  test('reads an error result that failed on the network, with its user message', () => {
    const failed = {
      type: 'result',
      subtype: 'success',
      is_error: true,
      result: 'API Error: 502 getaddrinfo ENOTFOUND chatgpt.com',
      user_message_uuid: 'u1',
    } as unknown as SDKMessage;
    expect(resultNetworkOutage(failed)).toEqual({
      errorText: 'API Error: 502 getaddrinfo ENOTFOUND chatgpt.com',
      userMessageUuid: 'u1',
    });
    expect(resultNetworkOutage({ ...failed, is_error: false } as unknown as SDKMessage)).toBeNull();
    expect(
      resultNetworkOutage({ ...failed, result: 'API Error: 401' } as unknown as SDKMessage)
    ).toBeNull();
  });
});

describe('NetworkOutagePause', () => {
  function harness(reachable: () => boolean) {
    let now = 1_000;
    const timers: Array<() => void> = [];
    const events: string[] = [];
    const holds: number[] = [];
    let held = true;
    let resumeFails = false;
    let stopOnPopup = false;
    const resumed: unknown[] = [];
    const pause = new NetworkOutagePause({
      now: () => now,
      fallbackHost: () => null,
      probe: async (host) => {
        events.push(`probe ${host}`);
        return reachable();
      },
      schedule: (run) => {
        timers.push(run);
        return () => {
          const index = timers.indexOf(run);
          if (index >= 0) timers.splice(index, 1);
        };
      },
      isHeld: () => held,
      hold: async (retryAt) => {
        holds.push(retryAt);
      },
      notice: async (text) => {
        events.push(`notice ${text}`);
      },
      popup: async () => {
        events.push('popup');
        if (stopOnPopup) pause.stop();
      },
      resume: async (prompt) => {
        if (resumeFails) throw new Error('Agent query did not start');
        resumed.push(prompt);
      },
      log: () => {},
    });
    const tick = async (advanceMs: number) => {
      now += advanceMs;
      const run = timers.shift();
      run?.();
      await new Promise((resolve) => setTimeout(resolve, 0));
    };
    return {
      pause,
      events,
      holds,
      resumed,
      tick,
      release: () => {
        held = false;
      },
      failResume: () => {
        resumeFails = true;
      },
      stopOnPopup: () => {
        stopOnPopup = true;
      },
    };
  }
  const prompt = { uuid: 'u1', content: 'ship it' };

  test('holds the turn with one notice and resumes it once the provider answers', async () => {
    let up = false;
    const h = harness(() => up);
    await h.pause.start('getaddrinfo ENOTFOUND chatgpt.com', prompt);
    await h.pause.start('getaddrinfo ENOTFOUND chatgpt.com', null);

    expect(h.events).toEqual([`notice ${NETWORK_OUTAGE_NOTICE}`]);
    expect(h.holds).toEqual([1_000 + NETWORK_PROBE_EVERY_MS, 1_000 + NETWORK_PROBE_EVERY_MS]);

    await h.tick(NETWORK_PROBE_EVERY_MS);
    expect(h.resumed).toEqual([]);
    up = true;
    await h.tick(NETWORK_PROBE_EVERY_MS);

    expect(h.resumed).toEqual([prompt]);
    expect(h.pause.isActive()).toBe(false);
    expect(h.events.filter((event) => event === 'popup')).toEqual([]);
  });

  test('raises the error popup once the outage passes the long threshold', async () => {
    const h = harness(() => false);
    await h.pause.start('connect ECONNREFUSED 10.0.0.5:443', prompt);
    await h.tick(NETWORK_OUTAGE_POPUP_AFTER_MS - 1);
    expect(h.events).not.toContain('popup');
    await h.tick(NETWORK_PROBE_EVERY_MS);
    await h.tick(NETWORK_PROBE_EVERY_MS);

    expect(h.events.filter((event) => event === 'popup')).toEqual(['popup']);
    expect(h.events).toContain('probe 10.0.0.5');
    expect(h.pause.isActive()).toBe(true);
  });

  test('a cancel during the popup leaves the session out of its hold', async () => {
    const h = harness(() => false);
    h.stopOnPopup();
    await h.pause.start('getaddrinfo ENOTFOUND chatgpt.com', prompt);
    await h.tick(NETWORK_OUTAGE_POPUP_AFTER_MS);

    expect(h.events).toContain('popup');
    expect(h.holds).toHaveLength(1);
    expect(h.pause.isActive()).toBe(false);
  });

  test('drops the pause without resuming when the human stopped the session', async () => {
    const h = harness(() => true);
    await h.pause.start('getaddrinfo ENOTFOUND chatgpt.com', prompt);
    h.release();
    await h.tick(NETWORK_PROBE_EVERY_MS);

    expect(h.resumed).toEqual([]);
    expect(h.pause.isActive()).toBe(false);
  });

  test('Retry Now resends the held prompt at once', async () => {
    const h = harness(() => false);
    expect(await h.pause.resumeNow()).toBe(false);
    await h.pause.start('getaddrinfo ENOTFOUND chatgpt.com', prompt);

    expect(await h.pause.resumeNow()).toBe(true);
    expect(h.resumed).toEqual([prompt]);
    expect(h.pause.isActive()).toBe(false);
  });

  test('a failing probe tick drops the pause instead of throwing', async () => {
    const h = harness(() => true);
    h.failResume();
    await h.pause.start('getaddrinfo ENOTFOUND chatgpt.com', prompt);
    await h.tick(NETWORK_PROBE_EVERY_MS);

    expect(h.pause.isActive()).toBe(false);
  });

  test('a successful turn ends the outage, so the next one gets a fresh notice', async () => {
    const h = harness(() => true);
    await h.pause.start('getaddrinfo ENOTFOUND chatgpt.com', prompt);
    expect(h.pause.takePrompt()).toEqual(prompt);
    h.pause.succeeded();
    await h.pause.start('getaddrinfo ENOTFOUND chatgpt.com', prompt);

    expect(h.events.filter((event) => event.startsWith('notice'))).toHaveLength(2);
  });
});
