import { useEffect, useRef, useState } from 'preact/hooks';
import { connectionManager } from '../../lib/connection-manager';
import { invokeOperation } from '../../lib/operations.ts';
import { globalSettings } from '../../lib/state.ts';
import { Button } from '../ui/Button.tsx';
import { SettingsSection } from './SettingsSection.tsx';

interface Device {
  id: string;
  name: string;
  kind: string;
}
type Refused = { ok: false; reason: string };
type Created =
  | { ok: true; code: string; expiresAt: number; approval: 'approved' | 'pending' }
  | Refused;
type Listed = { ok: true; devices: Device[] } | Refused;

type Flow =
  | { kind: 'idle' | 'starting' }
  | { kind: 'waiting'; code: string; expiresAt: number; pending: boolean }
  | { kind: 'paired'; name: string }
  | { kind: 'failed'; message: string };

async function call<T>(name: 'device.list' | 'device.pair.create', input: unknown = {}) {
  return invokeOperation<T>(await connectionManager.getHub(), name, input);
}

function daemonAddresses(): string[] {
  const port = location.port ? `:${location.port}` : '';
  const alternates = (globalSettings.value?.allowedHosts ?? [])
    .map((host) => `${location.protocol}//${host}${port}`)
    .filter((address) => address !== location.origin);
  return [location.origin, ...alternates];
}

const ON_LOOPBACK = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
const UNREACHABLE =
  'Could not reach the daemon. Check that it is running and that this page can connect, then try again.';
const EXPIRED = 'That code expired before the phone paired. Start pairing again for a new code.';

function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
}

export function PairPhoneFlow({
  pollMs = 2000,
  onPaired,
}: {
  pollMs?: number;
  onPaired?: () => void;
}) {
  const [flow, setFlow] = useState<Flow>({ kind: 'idle' });
  const current = useRef<AbortController | null>(null);
  useEffect(() => () => current.current?.abort(), []);

  const start = async () => {
    current.current?.abort();
    const controller = new AbortController();
    current.current = controller;
    setFlow({ kind: 'starting' });
    const created = await call<Created>('device.pair.create', { kind: 'human' }).catch(() => null);
    if (!created) {
      if (!controller.signal.aborted) setFlow({ kind: 'failed', message: UNREACHABLE });
      return;
    }
    if (controller.signal.aborted) return;
    if (!created.ok) {
      setFlow({ kind: 'failed', message: created.reason });
      return;
    }
    const { code, expiresAt, approval } = created;
    setFlow({ kind: 'waiting', code, expiresAt, pending: approval === 'pending' });
    const baseline = await call<Listed>('device.list').catch(() => null);
    if (!baseline?.ok) {
      if (!controller.signal.aborted) setFlow({ kind: 'failed', message: UNREACHABLE });
      return;
    }
    const known = new Set(baseline.devices.map((device) => device.id));
    let missed = 0;
    while (!controller.signal.aborted) {
      await pause(pollMs, controller.signal);
      const listed = await call<Listed>('device.list').catch(() => null);
      if (controller.signal.aborted) return;
      missed = listed?.ok ? 0 : missed + 1;
      if (missed >= 3) return setFlow({ kind: 'failed', message: UNREACHABLE });
      const arrived = listed?.ok
        ? listed.devices.find((device) => device.kind === 'human' && !known.has(device.id))
        : null;
      if (arrived) {
        setFlow({ kind: 'paired', name: arrived.name });
        onPaired?.();
        return;
      }
      if (listed?.ok && Date.now() > expiresAt) {
        setFlow({ kind: 'failed', message: EXPIRED });
        return;
      }
    }
  };

  const cancel = () => {
    current.current?.abort();
    setFlow({ kind: 'idle' });
  };

  const addresses = daemonAddresses();

  return (
    <SettingsSection
      title="Pair a phone"
      description="Show the Neo app on your phone how to reach this daemon."
    >
      <div class="space-y-3 rounded-xl border border-line bg-surface p-4 text-sm text-fg-soft">
        {flow.kind === 'idle' && (
          <>
            <p class="text-fg-muted">
              Start pairing, then enter the address and code it shows into the Neo app on your
              phone.
            </p>
            <Button onClick={() => void start()}>Start pairing</Button>
          </>
        )}
        {flow.kind === 'starting' && <p class="text-fg-muted">Making a pairing code...</p>}
        {flow.kind === 'waiting' && (
          <>
            <ol class="list-decimal space-y-3 pl-5">
              <li>
                <p class="text-fg-muted">
                  On your phone, open the Neo app and add a daemon with this address:
                </p>
                <div class="mt-1 font-mono break-all text-fg">{addresses[0]}</div>
                {addresses.length > 1 && (
                  <div class="mt-1 text-xs text-fg-faint">
                    This daemon also answers to: {addresses.slice(1).join(', ')}
                  </div>
                )}
                <p class="mt-1 text-xs text-fg-faint">
                  The phone must be on a network that can reach this daemon, such as the same Wi-Fi
                  or Tailscale.
                </p>
                {ON_LOOPBACK && (
                  <p class="mt-1 text-xs text-fg-faint">
                    This address only works on this Mac. On the phone, use this Mac's LAN address
                    (System Settings › Wi-Fi) or Tailscale name with the same port.
                  </p>
                )}
              </li>
              <li>
                <p class="text-fg-muted">Enter this pairing code:</p>
                <div class="mt-1 font-mono text-lg tracking-widest text-fg">{flow.code}</div>
                <div class="mt-1 text-xs text-fg-faint">Single use, valid for 10 minutes.</div>
              </li>
            </ol>
            {flow.pending && (
              <p class="text-xs text-fg-muted">
                This code also needs Allow on an already paired phone or browser before it works.
              </p>
            )}
            <p role="status" class="text-fg-muted">
              Waiting for the phone to pair...
            </p>
            <Button variant="secondary" onClick={cancel}>
              Cancel
            </Button>
          </>
        )}
        {flow.kind === 'paired' && (
          <>
            <p class="text-fg">Paired: {flow.name}</p>
            <p class="text-xs text-fg-faint">It now appears under Devices below.</p>
            <Button variant="secondary" onClick={cancel}>
              Done
            </Button>
          </>
        )}
        {flow.kind === 'failed' && (
          <>
            <p class="text-danger">{flow.message}</p>
            <div class="flex gap-2">
              <Button onClick={() => void start()}>Try again</Button>
              <Button variant="secondary" onClick={cancel}>
                Cancel
              </Button>
            </div>
          </>
        )}
      </div>
    </SettingsSection>
  );
}
