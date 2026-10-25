import { useEffect, useState } from 'preact/hooks';
import { connectionManager } from '../../lib/connection-manager';
import { updateGlobalSettings } from '../../lib/api-helpers.ts';
import { invokeOperation } from '../../lib/operations.ts';
import { globalSettings } from '../../lib/state.ts';
import { formatRelativeTime } from '../../lib/utils.ts';
import { Button } from '../ui/Button.tsx';
import { FORM_CONTROL_CLASS } from '../ui/FormField.tsx';
import { PairPhoneFlow } from './PairPhoneFlow.tsx';
import { SettingsGroup, SettingsSection } from './SettingsSection.tsx';

type Kind = 'human' | 'relay' | 'daemon';
type Refused = { ok: false; reason: string };
interface Device {
  id: string;
  name: string;
  kind: Kind;
  lastSeenAt: number | null;
  lastSeenHost: string | null;
  revokedAt: number | null;
  current: boolean;
}
interface Pending {
  id: string;
  kind: Kind;
  name: string | null;
  expiresAt: number;
}
interface WouldRefuse {
  reason: 'host_not_allowed' | 'origin_not_allowed';
  kind: 'http' | 'ws' | 'preflight';
  host: string | null;
  origin: string | null;
  count: number;
  lastSeenAt: number;
}
interface Unpaired {
  client: 'browser' | 'native';
  origin: string | null;
  host: string | null;
  remoteAddress: string | null;
  credentialRejected: boolean;
  count: number;
  lastSeenAt: number;
}
interface Code {
  code: string;
  kind: Kind;
  expiresAt: number;
}
type View =
  | { kind: 'loading' }
  | { kind: 'unpaired' }
  | { kind: 'failed'; reason: string }
  | {
      kind: 'ready';
      devices: Device[];
      pending: Pending[];
      unpaired: Unpaired[];
      wouldRefuse: WouldRefuse[];
    };

const REFUSAL_LABEL = {
  host_not_allowed: 'Host not allowed',
  origin_not_allowed: 'Origin not allowed',
  http: 'Page or file',
  ws: 'WebSocket',
  preflight: 'CORS preflight',
} as const;

const KIND_LABEL: Record<Kind, string> = {
  human: 'Phone or browser',
  relay: 'Push relay',
  daemon: 'Daemon',
};

async function call<T>(name: Parameters<typeof invokeOperation>[1], input: unknown = {}) {
  return invokeOperation<({ ok: true } & T) | Refused>(
    await connectionManager.getHub(),
    name,
    input
  );
}

async function loadView(): Promise<View> {
  const devices = await call<{ devices: Device[] }>('device.list');
  if (!devices.ok)
    return devices.reason.startsWith('not_paired')
      ? { kind: 'unpaired' }
      : { kind: 'failed', reason: devices.reason };
  const [pending, unpaired, wouldRefuse] = await Promise.all([
    call<{ pending: Pending[] }>('device.pair.pending'),
    call<{ connections: Unpaired[] }>('device.unpaired.list'),
    call<{ requests: WouldRefuse[] }>('device.would_refuse.list'),
  ]);
  return {
    kind: 'ready',
    devices: devices.devices,
    pending: pending.ok ? pending.pending : [],
    unpaired: unpaired.ok ? unpaired.connections : [],
    wouldRefuse: wouldRefuse.ok ? wouldRefuse.requests : [],
  };
}

const seen = (at: number | null) => (at ? formatRelativeTime(new Date(at)) : 'Never');

export function DevicesSettings() {
  const [view, setView] = useState<View>({ kind: 'loading' });
  const [confirming, setConfirming] = useState<string | null>(null);
  const [code, setCode] = useState<Code | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [newKind, setNewKind] = useState<Kind>('human');
  const [newName, setNewName] = useState('');
  const hosts = globalSettings.value?.allowedHosts ?? [];
  const [newHost, setNewHost] = useState('');
  const saveHosts = async (change: (current: string[]) => string[]) => {
    setError(null);
    const saved = await updateGlobalSettings({
      allowedHosts: change(globalSettings.value?.allowedHosts ?? []),
    }).catch(() => null);
    if (!saved?.success) setError('Could not save the allowed hosts.');
  };

  const reload = () =>
    loadView()
      .then(setView)
      .catch((failure: unknown) => setView({ kind: 'failed', reason: String(failure) }));
  useEffect(() => {
    void reload();
  }, []);

  const act = async (run: () => Promise<{ ok: boolean; reason?: string }>) => {
    setError(null);
    const result = await run().catch((failure: unknown) => ({
      ok: false,
      reason: String(failure),
    }));
    if (!result.ok) setError(result.reason ?? 'That did not work.');
    await reload();
  };
  const makeCode = async (kind: Kind, name: string) => {
    const made = await call<{ code: string; expiresAt: number }>('device.pair.create', {
      kind,
      name,
    });
    if (made.ok) setCode({ code: made.code, kind, expiresAt: made.expiresAt });
    return made;
  };
  const revoke = (device: Device) => act(() => call('device.revoke', { deviceId: device.id }));
  const repair = (device: Device) =>
    act(async () => {
      const made = await makeCode(device.kind, device.name);
      return made.ok ? call('device.revoke', { deviceId: device.id }) : made;
    });

  if (view.kind === 'loading')
    return (
      <SettingsSection title="Devices">
        {<div class="px-1 text-xs text-fg-faint">Loading devices...</div>}
      </SettingsSection>
    );
  if (view.kind === 'unpaired')
    return (
      <SettingsSection title="Devices">
        <div class="space-y-2 rounded-xl border border-line bg-surface p-4 text-sm text-fg-soft">
          <p>Pair this browser to manage devices.</p>
          <a class="font-medium text-accent hover:underline" href="/pair">
            Pair this browser
          </a>
        </div>
      </SettingsSection>
    );
  if (view.kind === 'failed')
    return (
      <SettingsSection title="Devices">
        <div class="px-1 text-xs text-danger">{view.reason}</div>
      </SettingsSection>
    );

  const link = code ? `${location.origin}/pair#${code.code}` : '';
  return (
    <>
      {error && <div class="px-1 text-xs text-danger">{error}</div>}
      <PairPhoneFlow onPaired={() => void reload()} />
      <SettingsSection
        title="Waiting for Allow"
        description="Codes made on the Mac's CLI pair only after a paired device allows them."
      >
        {view.pending.length === 0 ? (
          <div class="px-1 text-xs text-fg-faint">No codes are waiting for Allow.</div>
        ) : (
          <SettingsGroup>
            {view.pending.map((item) => (
              <div key={item.id} class="flex items-center gap-3 px-4 py-3">
                <div class="min-w-0 flex-1">
                  <div class="truncate text-sm font-medium text-fg-soft">
                    {item.name ?? 'Unnamed device'}
                  </div>
                  <div class="text-xs text-fg-faint">{KIND_LABEL[item.kind]}</div>
                </div>
                <Button
                  size="sm"
                  aria-label={`Allow ${item.name ?? 'Unnamed device'}`}
                  onClick={() => act(() => call('device.pair.approve', { codeId: item.id }))}
                >
                  Allow
                </Button>
              </div>
            ))}
          </SettingsGroup>
        )}
      </SettingsSection>
      <SettingsSection
        title="Devices"
        description="Paired phones, browsers, relays and daemons. Revoking closes a device's connections at once."
      >
        {code && (
          <div class="space-y-1 rounded-xl border border-accent/40 bg-accent/10 p-4 text-sm">
            <div class="font-mono text-lg tracking-widest text-fg">{code.code}</div>
            {code.kind === 'human' ? (
              <a class="break-all text-xs text-accent hover:underline" href={link}>
                {link}
              </a>
            ) : (
              <div class="text-xs text-fg-muted">
                Enter this code on the {KIND_LABEL[code.kind].toLowerCase()}.
              </div>
            )}
            <div class="text-xs text-fg-faint">Single use, valid for 10 minutes.</div>
          </div>
        )}
        <SettingsGroup>
          {view.devices.map((device) => (
            <div key={device.id} class="flex flex-wrap items-center gap-3 px-4 py-3">
              <div class="min-w-0 flex-1">
                <div class="truncate text-sm font-medium text-fg-soft">{device.name}</div>
                <div class="text-xs text-fg-faint">
                  {KIND_LABEL[device.kind]} · seen {seen(device.lastSeenAt)}
                  {device.lastSeenHost && (
                    <>
                      {' '}
                      · <span>{device.lastSeenHost}</span>
                    </>
                  )}
                </div>
              </div>
              {device.current ? (
                <span class="text-xs text-fg-muted">This browser</span>
              ) : device.revokedAt ? (
                <span class="text-xs text-fg-faint">Revoked</span>
              ) : (
                <div class="flex gap-2">
                  <Button
                    size="sm"
                    variant="secondary"
                    aria-label={`Re-pair ${device.name}`}
                    onClick={() => repair(device)}
                  >
                    Re-pair
                  </Button>
                  {confirming === device.id ? (
                    <Button
                      size="sm"
                      variant="danger"
                      aria-label={`Confirm revoke ${device.name}`}
                      onClick={() => {
                        setConfirming(null);
                        void revoke(device);
                      }}
                    >
                      Confirm
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      variant="secondary"
                      aria-label={`Revoke ${device.name}`}
                      onClick={() => setConfirming(device.id)}
                    >
                      Revoke
                    </Button>
                  )}
                </div>
              )}
            </div>
          ))}
        </SettingsGroup>
        <form
          class="flex flex-col gap-2 rounded-xl border border-line bg-surface p-4 sm:flex-row sm:items-end"
          onSubmit={(event) => {
            event.preventDefault();
            void act(() => makeCode(newKind, newName.trim()));
          }}
        >
          <label class="block sm:w-44">
            <span class="mb-1 block text-xs text-fg-muted">Kind</span>
            <select
              class={FORM_CONTROL_CLASS}
              value={newKind}
              onChange={(event) => setNewKind(event.currentTarget.value as Kind)}
            >
              {(Object.keys(KIND_LABEL) as Kind[]).map((kind) => (
                <option key={kind} value={kind}>
                  {KIND_LABEL[kind]}
                </option>
              ))}
            </select>
          </label>
          <label class="block flex-1">
            <span class="mb-1 block text-xs text-fg-muted">Name</span>
            <input
              class={FORM_CONTROL_CLASS}
              value={newName}
              maxLength={80}
              onInput={(event) => setNewName(event.currentTarget.value)}
            />
          </label>
          <Button type="submit" disabled={!newName.trim()}>
            Make pairing code
          </Button>
        </form>
      </SettingsSection>
      <SettingsSection
        title="Unpaired connections seen"
        description="Clients that connected without a paired credential. Nothing is refused yet; pair them before pairing is required."
      >
        {view.unpaired.length === 0 ? (
          <div class="px-1 text-xs text-fg-faint">None seen.</div>
        ) : (
          <SettingsGroup>
            {view.unpaired.map((item) => (
              <div
                key={`${item.client}${item.origin}${item.host}${item.remoteAddress}${item.credentialRejected}`}
                class="px-4 py-3"
              >
                <div class="truncate text-sm text-fg-soft">
                  {item.origin ?? (item.client === 'browser' ? 'Browser' : 'Native client')}
                </div>
                <div class="text-xs text-fg-faint">
                  {[item.host, item.remoteAddress, `seen ${seen(item.lastSeenAt)}`]
                    .filter(Boolean)
                    .join(' · ')}
                </div>
                <div class="text-xs text-fg-muted">
                  {item.credentialRejected ? 'Unknown credential' : 'No credential'} · {item.count}{' '}
                  {item.count === 1 ? 'time' : 'times'}
                </div>
              </div>
            ))}
          </SettingsGroup>
        )}
      </SettingsSection>
      <SettingsSection
        title="Allowed hosts"
        description="Names this daemon answers to besides localhost, such as its Tailscale MagicDNS name. Requests to other hosts or from other sites are only logged until pairing is required."
      >
        <SettingsGroup>
          {hosts.map((host) => (
            <div key={host} class="flex items-center gap-3 px-4 py-2">
              <span class="min-w-0 flex-1 truncate font-mono text-sm text-fg-soft">{host}</span>
              <Button
                size="sm"
                variant="secondary"
                aria-label={`Remove ${host}`}
                onClick={() => saveHosts((current) => current.filter((item) => item !== host))}
              >
                Remove
              </Button>
            </div>
          ))}
        </SettingsGroup>
        <form
          class="flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            const host = newHost.trim().toLowerCase();
            setNewHost('');
            if (host)
              void saveHosts((current) => (current.includes(host) ? current : [...current, host]));
          }}
        >
          <label class="block flex-1">
            <span class="sr-only">Allowed host</span>
            <input
              class={FORM_CONTROL_CLASS}
              placeholder="mac.tailnet.ts.net"
              value={newHost}
              onInput={(event) => setNewHost(event.currentTarget.value)}
            />
          </label>
          <Button type="submit" disabled={!newHost.trim()}>
            Add host
          </Button>
        </form>
      </SettingsSection>
      <SettingsSection
        title="Would be refused"
        description="Requests the Origin and Host checks will refuse once pairing is required. Add a host above if it is yours."
      >
        {view.wouldRefuse.length === 0 ? (
          <div class="px-1 text-xs text-fg-faint">None seen.</div>
        ) : (
          <SettingsGroup>
            {view.wouldRefuse.map((item) => (
              <div key={`${item.reason}${item.kind}${item.host}${item.origin}`} class="px-4 py-3">
                <div class="truncate text-sm text-fg-soft">
                  {[item.host, item.origin].filter(Boolean).join(' · ')}
                </div>
                <div class="text-xs text-fg-muted">
                  {REFUSAL_LABEL[item.reason]} · {REFUSAL_LABEL[item.kind]} · {item.count}{' '}
                  {item.count === 1 ? 'time' : 'times'}
                </div>
              </div>
            ))}
          </SettingsGroup>
        )}
      </SettingsSection>
    </>
  );
}
