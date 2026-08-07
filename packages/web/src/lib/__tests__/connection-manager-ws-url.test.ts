import { describe, it, expect } from 'vitest';
import { getDaemonWsUrl } from '../connection-manager';

describe('getDaemonWsUrl', () => {
  it('uses same origin with an explicit port (wss on https)', () => {
    expect(getDaemonWsUrl({ protocol: 'https:', hostname: 'host.example', port: '8399' })).toBe(
      'wss://host.example:8399'
    );
  });

  it('uses the protocol default port when no explicit port — regression: HTTPS on 443', () => {
    // Browsers omit default ports, so window.location.port is '' on https:443.
    // Previously this fell back to a hardcoded :8283, which nothing proxies under
    // a TLS-terminating reverse proxy (e.g. `tailscale serve --https 443`): the
    // page loads but the WebSocket dies → "connection lost".
    expect(
      getDaemonWsUrl({ protocol: 'https:', hostname: 'tts.tailcd822a.ts.net', port: '' })
    ).toBe('wss://tts.tailcd822a.ts.net');
  });

  it('uses ws: on plain http with no port', () => {
    expect(getDaemonWsUrl({ protocol: 'http:', hostname: 'localhost', port: '' })).toBe(
      'ws://localhost'
    );
  });
});
