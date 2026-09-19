import { useEffect, useState } from 'preact/hooks';
import { connectionManager } from '../../lib/connection-manager';
import { invokeOperation } from '../../lib/operations.ts';
import { toast } from '../../lib/toast.ts';
import { SettingsSection } from './SettingsSection.tsx';
import { Button } from '../ui/Button.tsx';

export interface AttachedDaemon {
  daemonId: string;
  url: string;
  addressExample: string;
}

type ListResult =
  | { kind: 'listed'; daemons: AttachedDaemon[] }
  | { kind: 'rejected'; reason: string };
type AttachResult = { kind: 'attached'; daemonId: string } | { kind: 'rejected'; reason: string };
type DetachResult =
  | { kind: 'detached'; daemonId: string }
  | { kind: 'not_attached'; daemonId: string }
  | { kind: 'rejected'; reason: string };
type ProbeResult =
  | { kind: 'reachable'; url: string }
  | { kind: 'unreachable'; url: string; reason: string }
  | { kind: 'rejected'; reason: string };

const DAEMON_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

const FIELD_CLASS =
  'w-full bg-bg border border-line rounded px-2 py-1.5 text-sm text-fg focus:outline-none focus:border-accent';

export function validateAttachForm(daemonId: string, url: string): string | null {
  if (!daemonId) return 'Daemon id is required';
  if (!DAEMON_ID_PATTERN.test(daemonId)) {
    return 'Daemon id must start with a letter or digit and use only letters, digits, . _ or -';
  }
  if (!url.startsWith('ws://') && !url.startsWith('wss://')) {
    return 'URL must be a ws:// or wss:// MessageHub endpoint';
  }
  return null;
}

function validateProbeUrl(url: string): string | null {
  if (!url.startsWith('ws://') && !url.startsWith('wss://')) {
    return 'URL must be a ws:// or wss:// MessageHub endpoint';
  }
  return null;
}

function hubOrThrow() {
  const hub = connectionManager.getHubIfConnected();
  if (!hub) throw new Error('Not connected to the daemon');
  return hub;
}

function messageOf(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

export function RemoteDaemonsSettings() {
  const [daemons, setDaemons] = useState<AttachedDaemon[] | null>(null);
  const [daemonId, setDaemonId] = useState('');
  const [url, setUrl] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [attaching, setAttaching] = useState(false);
  const [probingUrl, setProbingUrl] = useState<string | null>(null);
  const [detachingId, setDetachingId] = useState<string | null>(null);

  const load = async () => {
    try {
      const result = await invokeOperation<ListResult>(hubOrThrow(), 'daemon.list', {});
      if (result.kind === 'rejected') {
        toast.error(result.reason);
        return;
      }
      setDaemons(result.daemons);
    } catch (error) {
      toast.error(messageOf(error, 'Failed to load attached daemons'));
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const handleAttach = async () => {
    const trimmedId = daemonId.trim();
    const trimmedUrl = url.trim();
    const problem = validateAttachForm(trimmedId, trimmedUrl);
    setFormError(problem);
    if (problem) return;
    try {
      setAttaching(true);
      const result = await invokeOperation<AttachResult>(hubOrThrow(), 'daemon.attach', {
        daemonId: trimmedId,
        url: trimmedUrl,
      });
      if (result.kind === 'rejected') {
        toast.error(result.reason);
        return;
      }
      toast.success(`Attached '${result.daemonId}'`);
      setDaemonId('');
      setUrl('');
      await load();
    } catch (error) {
      toast.error(messageOf(error, 'Failed to attach the daemon'));
    } finally {
      setAttaching(false);
    }
  };

  const handleDetach = async (target: AttachedDaemon) => {
    try {
      setDetachingId(target.daemonId);
      const result = await invokeOperation<DetachResult>(hubOrThrow(), 'daemon.detach', {
        daemonId: target.daemonId,
      });
      if (result.kind === 'rejected') {
        toast.error(result.reason);
        return;
      }
      toast.success(`Detached '${target.daemonId}'`);
      await load();
    } catch (error) {
      toast.error(messageOf(error, 'Failed to detach the daemon'));
    } finally {
      setDetachingId(null);
    }
  };

  const handleProbe = async (targetUrl: string) => {
    const trimmedUrl = targetUrl.trim();
    const problem = validateProbeUrl(trimmedUrl);
    setFormError(problem);
    if (problem) return;
    try {
      setProbingUrl(trimmedUrl);
      const result = await invokeOperation<ProbeResult>(hubOrThrow(), 'daemon.probe', {
        url: trimmedUrl,
      });
      if (result.kind === 'reachable') {
        toast.success('Remote daemon is reachable');
      } else {
        toast.error(result.reason);
      }
    } catch (error) {
      toast.error(messageOf(error, 'Failed to test the remote daemon'));
    } finally {
      setProbingUrl(null);
    }
  };

  return (
    <SettingsSection title="Remote Daemons">
      <div class="rounded-lg border border-warning/40 bg-warning/10 px-4 py-3 text-xs text-fg-soft">
        Attachments are held in this daemon's memory and are gone when it restarts — you have to
        attach them again after every restart. Test a URL before attaching it to verify the remote
        operation door is reachable.
      </div>

      <div class="rounded-lg border border-line bg-fill-soft px-4 py-3 space-y-3">
        <div class="flex flex-col gap-3 sm:flex-row">
          <div class="sm:w-48">
            <label class="mb-1 block text-xs text-fg-muted" for="remote-daemon-id">
              Daemon id
            </label>
            <input
              id="remote-daemon-id"
              class={FIELD_CLASS}
              value={daemonId}
              placeholder="staging"
              onInput={(e) => setDaemonId((e.target as HTMLInputElement).value)}
            />
          </div>
          <div class="flex-1 min-w-0">
            <label class="mb-1 block text-xs text-fg-muted" for="remote-daemon-url">
              MessageHub URL
            </label>
            <input
              id="remote-daemon-url"
              class={`${FIELD_CLASS} font-mono`}
              value={url}
              placeholder="ws://host:8484/ws"
              onInput={(e) => setUrl((e.target as HTMLInputElement).value)}
            />
          </div>
        </div>
        {formError && <div class="text-xs text-danger">{formError}</div>}
        <div class="flex justify-end gap-2">
          <Button
            size="sm"
            variant="secondary"
            loading={probingUrl === url.trim() && probingUrl !== null}
            disabled={attaching || probingUrl !== null}
            onClick={() => void handleProbe(url)}
          >
            Test
          </Button>
          <Button
            size="sm"
            loading={attaching}
            disabled={attaching || probingUrl !== null}
            onClick={() => void handleAttach()}
          >
            Attach
          </Button>
        </div>
      </div>

      {daemons === null ? (
        <div class="px-1 text-xs text-fg-faint">Loading attached daemons...</div>
      ) : daemons.length === 0 ? (
        <div class="px-1 text-xs text-fg-faint">No remote daemons attached.</div>
      ) : (
        daemons.map((daemon) => (
          <div
            key={daemon.daemonId}
            class="flex items-center gap-3 rounded-lg border border-line bg-fill-soft px-4 py-3"
          >
            <div class="min-w-0 flex-1">
              <div class="truncate text-sm font-medium text-fg-soft">{daemon.daemonId}</div>
              <div class="truncate font-mono text-xs text-fg-faint">{daemon.url}</div>
              <div class="truncate font-mono text-xs text-fg-muted">{daemon.addressExample}</div>
            </div>
            <Button
              size="xs"
              variant="secondary"
              loading={probingUrl === daemon.url}
              disabled={probingUrl !== null || detachingId === daemon.daemonId}
              onClick={() => void handleProbe(daemon.url)}
            >
              Test
            </Button>
            <Button
              size="xs"
              variant="danger"
              loading={detachingId === daemon.daemonId}
              disabled={detachingId === daemon.daemonId}
              onClick={() => void handleDetach(daemon)}
            >
              Detach
            </Button>
          </div>
        ))
      )}
    </SettingsSection>
  );
}
