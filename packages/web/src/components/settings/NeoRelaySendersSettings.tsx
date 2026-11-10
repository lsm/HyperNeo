import { useEffect, useState } from 'preact/hooks';
import type { NeoSettings } from '@hyperneo/shared/types/settings';
import { connectionManager } from '../../lib/connection-manager';
import { invokeOperation } from '../../lib/operations.ts';
import { connectionState, globalSettings } from '../../lib/state.ts';
import { Button } from '../ui/Button';

type Sender = NonNullable<NeoSettings['relaySenders']>[number];
type Candidate = Sender & { lastMessageAt: string };

export function NeoRelaySendersSettings() {
  const saved = globalSettings.value?.neo?.relaySenders;
  const [senders, setSenders] = useState<Sender[]>(saved ?? []);
  const [recent, setRecent] = useState<Candidate[] | null>(null);
  const [selected, setSelected] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const connected = connectionState.value === 'connected';
  useEffect(() => setSenders(saved ?? []), [saved]);
  useEffect(() => {
    const hub = connectionManager.getHubIfConnected();
    if (!hub || !connected) return;
    let active = true;
    setError('');
    void invokeOperation<{ senders: Candidate[] } | { ok: false; reason: string }>(
      hub,
      'neo.relaySenders.recent',
      {}
    )
      .then((result) => {
        if (!active) return;
        if (!('senders' in result)) throw new Error(result.reason);
        setRecent(result.senders);
      })
      .catch((cause) => {
        if (active)
          setError(cause instanceof Error ? cause.message : 'Could not load recent senders.');
      });
    return () => {
      active = false;
    };
  }, [connected]);
  const available = (recent ?? []).filter(
    (candidate) => !senders.some((saved) => saved.sender === candidate.sender)
  );
  const candidate = available.find((candidate) => candidate.sender === selected);
  const busy = saving || !connected;

  async function save(next: Sender[]) {
    setSaving(true);
    setError('');
    try {
      const hub = connectionManager.getHubIfConnected();
      if (!hub) throw new Error('Reconnect before changing relay senders.');
      const result = await invokeOperation<{ ok: true } | { ok: false; reason: string }>(
        hub,
        'neo.relaySenders.set',
        { relaySenders: next }
      );
      if (!result.ok) throw new Error(result.reason);
      setSenders(next);
      setSelected('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not save relay senders.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <section
      aria-label="Who may relay my words"
      class="mt-4 space-y-3 rounded-xl border border-line bg-surface p-4"
    >
      <h4 class="text-[13px] font-semibold text-fg">Who may relay my words</h4>
      {senders.length ? (
        <ul class="space-y-2">
          {senders.map((sender) => (
            <li
              key={sender.sender}
              class="flex items-start gap-2 rounded-lg border border-line bg-surface-raised px-3 py-2"
            >
              <span class="min-w-0 flex-1">
                <span class="block text-sm text-fg-soft break-words">{sender.name}</span>
                <span class="block font-mono text-xs text-fg-faint break-all">{sender.sender}</span>
              </span>
              <Button
                variant="secondary"
                size="xs"
                disabled={busy}
                aria-label={`Remove ${sender.name}`}
                onClick={() => save(senders.filter((item) => item.sender !== sender.sender))}
              >
                Remove
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <p class="text-xs text-fg-faint">No relay senders saved.</p>
      )}
      <label class="block space-y-1 text-xs text-fg-soft">
        <span class="block">Recent sender</span>
        <select
          value={selected}
          disabled={busy || !available.length}
          onChange={(event) => setSelected(event.currentTarget.value)}
          class="block w-full min-w-0 rounded border border-line bg-surface px-2 py-2 text-sm text-fg"
        >
          <option value="">Choose a sender</option>
          {available.map((sender) => (
            <option key={sender.sender} value={sender.sender}>
              {sender.name} · {sender.sender}
            </option>
          ))}
        </select>
      </label>
      {recent !== null && !available.length ? (
        <p class="text-xs text-fg-faint">No recent senders available.</p>
      ) : null}
      {error ? (
        <p role="alert" class="text-xs text-danger">
          {error}
        </p>
      ) : null}
      <div class="flex justify-end">
        <Button
          size="sm"
          disabled={busy || !candidate}
          onClick={() =>
            candidate && save([...senders, { sender: candidate.sender, name: candidate.name }])
          }
        >
          Add sender
        </Button>
      </div>
    </section>
  );
}
