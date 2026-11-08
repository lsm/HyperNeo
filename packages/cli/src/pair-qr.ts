import qrcode from 'qrcode-generator';

const QUIET = 4;
const DARK = 30;
const LIGHT = 97;
const POLL_MS = 1000;

type Pending = { id: string; requestedName: string | null; fingerprint: string[] | null };
type PendingReply = { ok: true; pending: Pending[] } | { ok: false; reason: string };
type Created = { ok: true; codeId: string; code: string; expiresAt: number };

export type PairWatch =
  | { kind: 'waiting' }
  | { kind: 'confirm'; name: string; groups: string[] }
  | { kind: 'stop'; message: string; exit: number };

export interface PairQrDeps {
  call: (name: string, input: unknown) => Promise<unknown>;
  tailscale: (args: string[]) => Promise<unknown>;
  port: () => number | null;
  ask: (question: string) => Promise<string>;
  print: (text: string) => void;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

export function tailnetAddress(status: unknown): string | null {
  const { BackendState, Self } = (status ?? {}) as {
    BackendState?: string;
    Self?: { DNSName?: string; TailscaleIPs?: string[] };
  };
  if (BackendState !== 'Running' || !Self) return null;
  const name = Self.DNSName?.replace(/\.$/, '') ?? '';
  if (name.endsWith('.ts.net')) return name;
  const ip = Self.TailscaleIPs?.find((value) => /^100\.|^fd7a:/i.test(value));
  if (!ip) return null;
  return ip.includes(':') ? `[${ip}]` : ip;
}

const isTailnetHost = (host: string) =>
  /\.ts\.net$/.test(host) || /^100\./.test(host) || /^\[fd7a:/i.test(host);

export function pairOrigin(
  host: string | null,
  port: number | null,
  serve: unknown,
  override?: string
): string | null {
  if (override) {
    const url = URL.canParse(override) ? new URL(override) : null;
    return url && /^https?:$/.test(url.protocol) && isTailnetHost(url.hostname) ? url.origin : null;
  }
  if (!host || !port) return null;
  const { TCP, Web } = (serve ?? {}) as { TCP?: object; Web?: object };
  const https =
    Object.keys(TCP ?? {}).includes('443') ||
    Object.keys(Web ?? {}).some((key) => key.endsWith(':443'));
  return https ? `https://${host}` : `http://${host}:${port}`;
}

export const pairLink = (code: string, origin: string) =>
  `hyperneo://pair?v=1&c=${encodeURIComponent(code)}&a=${encodeURIComponent(origin)}`;

export function renderQr(isDark: (row: number, col: number) => boolean, size: number): string {
  const side = size + QUIET * 2;
  const dark = (row: number, col: number) =>
    row >= QUIET && row < size + QUIET && col >= QUIET && col < size + QUIET
      ? isDark(row - QUIET, col - QUIET)
      : false;
  const lines: string[] = [];
  for (let row = 0; row < side; row += 2) {
    let line = '';
    for (let col = 0; col < side; col++) {
      const fg = dark(row, col) ? DARK : LIGHT;
      const bg = (row + 1 < side && dark(row + 1, col) ? DARK : LIGHT) + 10;
      line += `\x1b[${fg};${bg}m▀`;
    }
    lines.push(`${line}\x1b[0m`);
  }
  return lines.join('\n');
}

export function planPairWatch(
  reply: PendingReply,
  code: { codeId: string; expiresAt: number },
  now: number
): PairWatch {
  const stop = (message: string, exit = 0) => ({ kind: 'stop' as const, message, exit });
  if (!reply.ok)
    return stop('Terminal approval is off. Allow this device on a paired phone or browser.');
  if (now >= code.expiresAt) return stop('The code expired. Run hyperneo pair --qr again.', 1);
  const entry = reply.pending.find((item) => item.id === code.codeId);
  if (!entry) return stop('The code was used or withdrawn. Check the new device.');
  return entry.fingerprint
    ? { kind: 'confirm', name: entry.requestedName ?? 'New device', groups: entry.fingerprint }
    : { kind: 'waiting' };
}

export async function runPairQr(args: string[], deps: PairQrDeps): Promise<number> {
  const flag = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
  const name = flag('--name');
  const origin = pairOrigin(
    tailnetAddress(await deps.tailscale(['status', '--json'])),
    deps.port(),
    await deps.tailscale(['serve', 'status', '--json']),
    flag('--address')
  );
  if (!origin) {
    deps.print(
      'No Tailscale address for the daemon. Start Tailscale, or pass --address https://<tailnet name>.'
    );
    return 1;
  }
  const made = (await deps.call('device.pair.create', {
    kind: 'human',
    confirm: 'two-way',
    ...(name ? { name } : {}),
  })) as Created | { ok: false; reason: string };
  if (!made.ok) {
    deps.print(made.reason);
    return 1;
  }
  const qr = qrcode(0, 'M');
  qr.addData(pairLink(made.code, origin));
  qr.make();
  deps.print(renderQr((row, col) => qr.isDark(row, col), qr.getModuleCount()));
  deps.print(`Scan in the HyperNeo app. Expires ${new Date(made.expiresAt).toLocaleTimeString()}.`);
  for (;;) {
    const reply = (await deps.call('device.pair.pending', {})) as PendingReply;
    const watch = planPairWatch(reply, made, deps.now());
    if (watch.kind === 'waiting') {
      await deps.sleep(POLL_MS);
      continue;
    }
    if (watch.kind === 'stop') {
      deps.print(watch.message);
      return watch.exit;
    }
    deps.print(`${watch.name} wants to pair: ${watch.groups.join(' ')} ????`);
    const lastGroup = (await deps.ask('Type the last group shown on the device: ')).trim();
    const approved = (await deps.call('device.pair.approve', {
      codeId: made.codeId,
      lastGroup: lastGroup.toLowerCase(),
    })) as { ok: boolean; reason?: string };
    deps.print(approved.ok ? 'Allowed. The device finishes pairing now.' : (approved.reason ?? ''));
    return approved.ok ? 0 : 1;
  }
}
