import { describe, expect, test } from 'bun:test';
import qrcode from 'qrcode-generator';
import {
  pairLink,
  pairOrigin,
  planPairWatch,
  renderQr,
  runPairQr,
  tailnetAddress,
} from '../src/pair-qr';

const DARK = 30;

function decode(text: string): boolean[][] {
  const rows: boolean[][] = [];
  for (const line of text.split('\n').filter(Boolean)) {
    const cells = [...line.matchAll(/\x1b\[(\d+);(\d+)m▀/g)];
    rows.push(cells.map((cell) => Number(cell[1]) === DARK));
    rows.push(cells.map((cell) => Number(cell[2]) === DARK + 10));
  }
  return rows;
}

describe('tailnetAddress', () => {
  test('prefers the MagicDNS name, then a tailnet IP, else nothing', () => {
    const self = { DNSName: 'mac.example.ts.net.', TailscaleIPs: ['100.64.0.1', 'fd7a:115c::1'] };
    expect(tailnetAddress({ BackendState: 'Running', Self: self })).toBe('mac.example.ts.net');
    expect(
      tailnetAddress({ BackendState: 'Running', Self: { ...self, DNSName: 'mac.local.' } })
    ).toBe('100.64.0.1');
    expect(
      tailnetAddress({
        BackendState: 'Running',
        Self: { DNSName: '', TailscaleIPs: ['fd7a:115c::1'] },
      })
    ).toBe('[fd7a:115c::1]');
    expect(tailnetAddress({ BackendState: 'Stopped', Self: self })).toBeNull();
    expect(
      tailnetAddress({
        BackendState: 'Running',
        Self: { DNSName: '', TailscaleIPs: ['192.168.1.2'] },
      })
    ).toBeNull();
    expect(tailnetAddress('not json')).toBeNull();
  });
});

describe('pairLink', () => {
  test('carries only the version, the one-time code and the tailnet origin', () => {
    expect(pairLink('ABCDEFGH23', 'https://mac.example.ts.net')).toBe(
      'hyperneo://pair?v=1&c=ABCDEFGH23&a=https%3A%2F%2Fmac.example.ts.net'
    );
  });
});

describe('pairOrigin', () => {
  const host = 'mac.example.ts.net';
  test('uses HTTPS when tailscale serve publishes 443, else the daemon port', () => {
    expect(pairOrigin(host, 8399, { TCP: { '443': {} } })).toBe('https://mac.example.ts.net');
    expect(pairOrigin(host, 8399, { Web: { 'mac.example.ts.net:443': {} } })).toBe(
      'https://mac.example.ts.net'
    );
    expect(pairOrigin(host, 8399, null)).toBe('http://mac.example.ts.net:8399');
    expect(pairOrigin(null, 8399, null)).toBeNull();
    expect(pairOrigin(host, null, null)).toBeNull();
  });

  test('accepts an --address only on a tailnet host', () => {
    expect(pairOrigin(null, null, null, 'https://mac.example.ts.net:8443/x')).toBe(
      'https://mac.example.ts.net:8443'
    );
    expect(pairOrigin(host, 8399, null, 'http://100.64.0.1:8399')).toBe('http://100.64.0.1:8399');
    expect(pairOrigin(host, 8399, null, 'https://evil.example.com')).toBeNull();
    expect(pairOrigin(host, 8399, null, 'ftp://mac.example.ts.net')).toBeNull();
    expect(pairOrigin(host, 8399, null, 'not a url')).toBeNull();
  });
});

describe('renderQr', () => {
  test('round-trips every module with a 4-module light quiet zone and a light pad row', () => {
    const qr = qrcode(0, 'M');
    qr.addData(pairLink('ABCDEFGH23', 'https://mac.example.ts.net'));
    qr.make();
    const size = qr.getModuleCount();
    const text = renderQr((row, col) => qr.isDark(row, col), size);
    const rows = decode(text);
    const side = size + 8;
    expect(rows[0]).toHaveLength(side);
    expect(rows).toHaveLength(side % 2 ? side + 1 : side);
    for (let row = 0; row < rows.length; row++)
      for (let col = 0; col < side; col++) {
        const inside = row >= 4 && row < size + 4 && col >= 4 && col < size + 4;
        expect(rows[row][col]).toBe(inside ? qr.isDark(row - 4, col - 4) : false);
      }
    expect(
      text
        .split('\n')
        .filter(Boolean)
        .every((line) => line.endsWith('\x1b[0m'))
    ).toBe(true);
  });
});

describe('planPairWatch', () => {
  const code = { codeId: 'c1', expiresAt: 10_000 };
  test('waits for the phone, then asks for the last group once it confirmed', () => {
    const entry = { id: 'c1', requestedName: 'Phone', fingerprint: null };
    expect(planPairWatch({ ok: true, pending: [entry] }, code, 1)).toEqual({ kind: 'waiting' });
    expect(
      planPairWatch(
        { ok: true, pending: [{ ...entry, fingerprint: ['1', '2', '3', '4', '5', '6', '7'] }] },
        code,
        1
      )
    ).toEqual({ kind: 'confirm', name: 'Phone', groups: ['1', '2', '3', '4', '5', '6', '7'] });
  });

  test('stops when the terminal may not approve, the code is gone, or it expired', () => {
    expect(planPairWatch({ ok: false, reason: 'not_paired' }, code, 1)).toMatchObject({
      kind: 'stop',
      message: expect.stringContaining('paired phone or browser'),
      exit: 0,
    });
    expect(planPairWatch({ ok: true, pending: [] }, code, 1)).toMatchObject({
      kind: 'stop',
      message: expect.stringContaining('used or withdrawn'),
    });
    expect(planPairWatch({ ok: true, pending: [] }, code, 10_000)).toMatchObject({
      kind: 'stop',
      message: expect.stringContaining('expired'),
      exit: 1,
    });
  });
});

describe('runPairQr', () => {
  test('creates a two-way code, shows the QR, and approves with the typed last group', async () => {
    const calls: { name: string; input: unknown }[] = [];
    const replies: Record<string, unknown[]> = {
      'device.pair.create': [{ ok: true, codeId: 'c1', code: 'ABCDEFGH23', expiresAt: 600_000 }],
      'device.pair.pending': [
        { ok: true, pending: [{ id: 'c1', requestedName: null, fingerprint: null }] },
        {
          ok: true,
          pending: [
            { id: 'c1', requestedName: 'Phone', fingerprint: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] },
          ],
        },
      ],
      'device.pair.approve': [{ ok: true }],
    };
    const out: string[] = [];
    const code = await runPairQr(['--qr', '--name', 'Phone'], {
      call: async (name, input) => {
        calls.push({ name, input });
        return replies[name].shift();
      },
      tailscale: async (args) =>
        args[0] === 'status'
          ? { BackendState: 'Running', Self: { DNSName: 'mac.example.ts.net.', TailscaleIPs: [] } }
          : { TCP: { '443': {} } },
      port: () => 8399,
      ask: async () => ' 7DCC ',
      print: (text) => out.push(text),
      now: () => 1,
      sleep: async () => {},
    });
    expect(code).toBe(0);
    expect(calls.map((call) => call.name)).toEqual([
      'device.pair.create',
      'device.pair.pending',
      'device.pair.pending',
      'device.pair.approve',
    ]);
    expect(calls[0].input).toEqual({ kind: 'human', confirm: 'two-way', name: 'Phone' });
    expect(calls[3].input).toEqual({ codeId: 'c1', lastGroup: '7dcc' });
    expect(out.join('\n')).toContain('a b c d e f g ????');
    expect(out.join('\n')).not.toContain('ABCDEFGH23');
  });

  test('refuses without a tailnet address and creates no code', async () => {
    const calls: string[] = [];
    const out: string[] = [];
    const code = await runPairQr(['--qr'], {
      call: async (name) => {
        calls.push(name);
        return {};
      },
      tailscale: async () => null,
      port: () => 8399,
      ask: async () => '',
      print: (text) => out.push(text),
      now: () => 1,
      sleep: async () => {},
    });
    expect(code).toBe(1);
    expect(calls).toEqual([]);
    expect(out.join('\n')).toContain('Tailscale');
  });
});
