import { useEffect, useState } from 'preact/hooks';
import { connectionManager } from '../../lib/connection-manager';
import { invokeOperation } from '../../lib/operations.ts';
import { globalSettings, sessions } from '../../lib/state.ts';
import { Button } from '../ui/Button';

function sessionName(key: string): string | null {
  const [adapter, daemon, ...id] = key.split(':');
  if (adapter !== 'hyperneo' || daemon) return null;
  return sessions.value.find((session) => session.id === id.join(':'))?.title || null;
}

export function NeoMutedSessionsSettings() {
  const savedMuted = globalSettings.value?.neo?.mutedSessions;
  const [muted, setMuted] = useState<string[]>(savedMuted ?? []);
  const [pending, setPending] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  useEffect(() => setMuted(savedMuted ?? []), [savedMuted]);

  async function unmute(key: string) {
    setPending(key);
    setErrors((current) => Object.fromEntries(Object.entries(current).filter(([k]) => k !== key)));
    try {
      const hub = connectionManager.getHubIfConnected();
      if (!hub) throw new Error('Reconnect before unmuting a session.');
      const result = await invokeOperation<
        { ok: true; mutedSessions: string[] } | { ok: false; reason: string }
      >(hub, 'neo.session.mute', { key, muted: false });
      if (!result.ok) throw new Error(result.reason);
      setMuted(result.mutedSessions);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : 'Could not unmute this session.';
      setErrors((current) => ({ ...current, [key]: message }));
    } finally {
      setPending(null);
    }
  }

  return (
    <section
      aria-label="Neo muted sessions"
      class="mt-4 space-y-3 rounded-xl border border-line bg-surface p-4"
    >
      <div>
        <h4 class="text-[13px] font-semibold text-fg">Muted sessions</h4>
        <p class="text-xs text-fg-faint mt-0.5">
          Neo sends no needs-you or failed notices about these sessions. Unmute one to get its
          notices again.
        </p>
      </div>
      {muted.length ? (
        <ul class="space-y-2">
          {muted.map((key) => {
            const name = sessionName(key);
            return (
              <li key={key} class="space-y-1">
                <div class="flex items-start gap-2 rounded-lg border border-line bg-surface-raised px-3 py-2">
                  <span class="flex-1 min-w-0">
                    {name ? (
                      <span class="block text-sm text-fg-soft break-words">{name}</span>
                    ) : null}
                    <span class="block font-mono text-xs text-fg-faint break-all">{key}</span>
                  </span>
                  <Button
                    variant="secondary"
                    size="xs"
                    disabled={pending !== null}
                    aria-label={`Unmute ${name ?? key}`}
                    onClick={() => unmute(key)}
                  >
                    {pending === key ? 'Unmuting…' : 'Unmute'}
                  </Button>
                </div>
                {errors[key] ? <p class="text-xs text-danger">{errors[key]}</p> : null}
              </li>
            );
          })}
        </ul>
      ) : (
        <p class="text-xs text-fg-faint">No muted sessions.</p>
      )}
    </section>
  );
}
