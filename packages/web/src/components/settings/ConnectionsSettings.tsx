import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import superpipe, { type PipelineAPI } from 'superpipe';
import { connectionManager } from '../../lib/connection-manager';
import { invokeOperation } from '../../lib/operations.ts';
import { t, type MessageKey } from '../../lib/i18n/index.ts';
import { Button } from '../ui/Button.tsx';
import { FORM_CONTROL_CLASS } from '../ui/FormField.tsx';
import { SettingsSection, SettingsGroup } from './SettingsSection.tsx';

type Account = {
  id: string;
  email: string;
  scopes: string[];
  health: 'healthy' | 'reconnect_needed' | 'disconnected';
};
type Attempt = {
  state: 'pending' | 'complete' | 'failed' | 'missing';
  reason?: string;
  authorizeUrl?: string;
  storage?: { warning?: string };
};
type Command = {
  name: 'connections.google.connect' | 'connections.google.disconnect';
  input: unknown;
};
type Receipt = Partial<Attempt> & { ok?: boolean };
type View = { accounts: Account[]; attempt: Attempt };
const call = async <T,>(name: Parameters<typeof invokeOperation>[1], input?: unknown) =>
  invokeOperation<T>(await connectionManager.getHub(), name, input);

const update = (superpipe({})('google-connection-settings') as PipelineAPI)
  .input('command')
  .pipe(
    (command?: Command) => (command ? call<Receipt>(command.name, command.input) : null),
    'command',
    'receipt'
  )
  .pipe(
    (_receipt: Receipt | null) =>
      Promise.all([
        call<{ connections: Account[] }>('connections.list'),
        call<Attempt>('connections.google.login'),
      ]),
    'receipt',
    'snapshot'
  )
  .pipe(
    ([rows, attempt]: [{ connections: Account[] }, Attempt], receipt: Receipt | null) => ({
      accounts: rows.connections,
      attempt,
      receipt,
    }),
    ['snapshot', 'receipt'],
    'view'
  )
  .endAsync('view') as (command?: Command) => Promise<View & { receipt: Receipt | null }>;

const scopeLabels: Record<string, MessageKey> = {
  openid: 'connections.identity',
  email: 'connections.email',
  'https://www.googleapis.com/auth/gmail.readonly': 'connections.gmailRead',
  'https://www.googleapis.com/auth/gmail.compose': 'connections.gmailDraft',
  'https://www.googleapis.com/auth/calendar.calendarlist.readonly': 'connections.calendars',
  'https://www.googleapis.com/auth/calendar.events.readonly': 'connections.events',
};

export function ConnectionsSettings() {
  const [view, setView] = useState<View>({ accounts: [], attempt: { state: 'missing' } });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [setup, setSetup] = useState<{ connectionId?: string } | null>(null);
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [consentUrl, setConsentUrl] = useState('');
  const popup = useRef<Window | null>(null);
  const reload = useCallback(async (command?: Command) => {
    const next = await update(command);
    setView(next);
    return next.receipt;
  }, []);
  useEffect(() => {
    const load = () => {
      void reload().catch((failure: unknown) => setError(String(failure)));
    };
    load();
    const timer = setInterval(load, view.attempt.state === 'pending' ? 1000 : 15000);
    return () => clearInterval(timer);
  }, [reload, view.attempt.state]);
  const act = async (command: Command) => {
    setBusy(true);
    setError('');
    const window =
      command.name === 'connections.google.connect'
        ? globalThis.window.open('about:blank', '_blank')
        : null;
    if (window) window.opener = null;
    try {
      const receipt = await reload(command);
      if (receipt?.reason === 'client_not_configured') {
        setSetup(command.input as { connectionId?: string });
      } else if (receipt?.state === 'failed' || receipt?.ok === false) {
        setError(receipt.reason ?? t('connections.failed'));
      } else if (receipt?.authorizeUrl) {
        popup.current?.close();
        popup.current = window;
        setConsentUrl(receipt.authorizeUrl);
        if (window) window.location.href = receipt.authorizeUrl;
        setSetup(null);
        return;
      }
    } catch (failure) {
      setError(String(failure));
    } finally {
      setBusy(false);
    }
    window?.close();
  };
  const failure = error || (view.attempt.state === 'failed' ? view.attempt.reason : '');
  return (
    <SettingsSection
      title={t('connections.title')}
      description={t('connections.description')}
      actions={
        <Button disabled={busy} onClick={() => setSetup({})}>
          {t('connections.connect')}
        </Button>
      }
    >
      {failure && (
        <p role="alert" class="text-sm text-danger">
          {t('connections.failed')}: {failure}
        </p>
      )}
      {view.attempt.storage?.warning && (
        <p class="text-sm text-warning">{t('connections.storageWarning')}</p>
      )}
      {view.attempt.state === 'pending' && (
        <p role="status" class="text-sm text-fg-soft">
          {t('connections.pending')}
          {consentUrl && (
            <a
              class="ml-2 text-accent hover:underline"
              href={consentUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              {t('connections.continue')}
            </a>
          )}
        </p>
      )}
      {setup && (
        <form
          class="space-y-3 rounded-xl border border-line p-4"
          onSubmit={(event) => {
            event.preventDefault();
            void act({
              name: 'connections.google.connect',
              input: { ...setup, clientId, ...(clientSecret ? { clientSecret } : {}) },
            });
            setClientSecret('');
          }}
        >
          <p class="text-sm text-fg-soft">{t('connections.setup')}</p>
          <label class="block text-sm text-fg-soft">
            {t('connections.clientId')}
            <input
              class={FORM_CONTROL_CLASS}
              required
              value={clientId}
              autoComplete="off"
              onInput={(event) => setClientId(event.currentTarget.value)}
            />
          </label>
          <label class="block text-sm text-fg-soft">
            {t('connections.clientSecret')}
            <input
              class={FORM_CONTROL_CLASS}
              type="password"
              value={clientSecret}
              autoComplete="off"
              onInput={(event) => setClientSecret(event.currentTarget.value)}
            />
          </label>
          <div class="flex gap-2">
            <Button type="submit" disabled={busy}>
              {t('connections.continue')}
            </Button>
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => {
                setSetup(null);
                setClientSecret('');
              }}
            >
              {t('connections.cancel')}
            </Button>
          </div>
        </form>
      )}
      {!view.accounts.length && <p class="text-sm text-fg-muted">{t('connections.empty')}</p>}
      <SettingsGroup>
        {view.accounts.map((account) => (
          <div key={account.id} class="flex flex-wrap items-start justify-between gap-4 px-4 py-4">
            <div class="min-w-0 flex-1">
              <p class="break-all font-medium text-fg">{account.email}</p>
              <p class="text-sm text-fg-soft">{t(`connections.${account.health}`)}</p>
              <p class="mt-2 text-xs text-fg-muted">{t('connections.scopes')}</p>
              <ul class="text-sm text-fg-soft">
                {account.scopes.map((scope) => (
                  <li key={scope} class="break-all" title={scope}>
                    {scopeLabels[scope] ? t(scopeLabels[scope]) : scope}
                  </li>
                ))}
              </ul>
            </div>
            <div class="flex flex-wrap gap-2">
              {(['connect', 'disconnect'] as const).map((action) => (
                <Button
                  key={action}
                  variant="secondary"
                  size="sm"
                  disabled={busy}
                  onClick={() =>
                    void act({
                      name: `connections.google.${action}`,
                      input: { connectionId: account.id },
                    })
                  }
                >
                  {t(`connections.${action === 'connect' ? 'reconnect' : action}`)}
                </Button>
              ))}
            </div>
          </div>
        ))}
      </SettingsGroup>
    </SettingsSection>
  );
}
