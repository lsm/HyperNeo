import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import superpipe, { type PipelineAPI } from 'superpipe';
import { connectionManager } from '../../lib/connection-manager';
import { invokeOperation } from '../../lib/operations.ts';
import { t, type MessageKey } from '../../lib/i18n/index.ts';
import { Button } from '../ui/Button.tsx';
import { FORM_CONTROL_CLASS } from '../ui/FormField.tsx';
import { SettingsSection, SettingsGroup } from './SettingsSection.tsx';

type Provider = 'google' | 'microsoft';
type Account = {
  id: string;
  provider: Provider;
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
type Command = { provider: Provider; action: 'connect' | 'disconnect'; input: unknown };
type Receipt = Partial<Attempt> & { ok?: boolean };
type View = { accounts: Account[]; attempt: Attempt };
const call = async <T,>(name: Parameters<typeof invokeOperation>[1], input: unknown = {}) =>
  invokeOperation<T>(await connectionManager.getHub(), name, input);

const update = (superpipe({})('google-connection-settings') as PipelineAPI)
  .input(['provider', 'command'])
  .pipe(
    (command?: Command) =>
      command
        ? call<Receipt>(`connections.${command.provider}.${command.action}`, command.input)
        : null,
    'command',
    'receipt'
  )
  .pipe(
    (provider: Provider, _receipt: Receipt | null) =>
      Promise.all([
        call<{ connections: Account[] }>('connections.list'),
        call<Attempt>(`connections.${provider}.login`),
      ]),
    ['provider', 'receipt'],
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
  .endAsync('view') as (
  provider: Provider,
  command?: Command
) => Promise<View & { receipt: Receipt | null }>;

const scopeLabels: Record<string, MessageKey> = {
  openid: 'connections.identity',
  email: 'connections.email',
  'https://www.googleapis.com/auth/gmail.readonly': 'connections.gmailRead',
  'https://www.googleapis.com/auth/gmail.compose': 'connections.gmailDraft',
  'https://www.googleapis.com/auth/calendar.calendarlist.readonly': 'connections.calendars',
  'https://www.googleapis.com/auth/calendar.events.readonly': 'connections.events',
  'Mail.ReadWrite': 'connections.outlookMail',
  'Calendars.Read': 'connections.outlookCalendars',
  profile: 'connections.profile',
  offline_access: 'connections.offlineAccess',
};

const copy = {
  google: {
    connect: 'connections.connect',
    pending: 'connections.pending',
    continue: 'connections.continue',
    setup: 'connections.setup',
    clientId: 'connections.clientId',
    sameAccount: 'connections.sameAccount',
    failed: 'connections.failed',
  },
  microsoft: {
    connect: 'connections.connectMicrosoft',
    pending: 'connections.pendingMicrosoft',
    continue: 'connections.continueMicrosoft',
    setup: 'connections.setupMicrosoft',
    clientId: 'connections.clientIdMicrosoft',
    sameAccount: 'connections.sameAccountMicrosoft',
    failed: 'connections.failedMicrosoft',
  },
} satisfies Record<Provider, Record<string, MessageKey>>;

export function ConnectionsSettings() {
  const [view, setView] = useState<View>({ accounts: [], attempt: { state: 'missing' } });
  const [error, setError] = useState('');
  const [readError, setReadError] = useState('');
  const [busy, setBusy] = useState(false);
  const [provider, setProvider] = useState<Provider>('google');
  const [setup, setSetup] = useState<{ connectionId?: string } | null>(null);
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [consentUrl, setConsentUrl] = useState('');
  const popup = useRef<Window | null>(null);
  const reload = useCallback(async (from: Provider, command?: Command) => {
    const next = await update(from, command);
    setReadError('');
    setView(next);
    return next.receipt;
  }, []);
  useEffect(() => {
    const load = () => {
      void reload(provider).catch((failure: unknown) => setReadError(String(failure)));
    };
    load();
    const timer = setInterval(load, view.attempt.state === 'pending' ? 1000 : 15000);
    return () => clearInterval(timer);
  }, [reload, provider, view.attempt.state]);
  const text = copy[provider];
  const act = async (command: Command) => {
    setBusy(true);
    setError('');
    setProvider(command.provider);
    const window =
      command.action === 'connect' ? globalThis.window.open('about:blank', '_blank') : null;
    if (window) window.opener = null;
    try {
      const receipt = await reload(command.provider, command);
      if (receipt?.reason === 'client_not_configured') {
        setSetup(command.input as { connectionId?: string });
      } else if (receipt?.state === 'failed' || receipt?.ok === false) {
        setError(receipt.reason ?? t(copy[command.provider].failed));
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
  const failure =
    error || readError || (view.attempt.state === 'failed' ? view.attempt.reason : '');
  return (
    <SettingsSection
      title={t('connections.tabAccounts')}
      description={t('connections.description')}
    >
      <div class="flex flex-wrap gap-2">
        {(['google', 'microsoft'] as const).map((next) => (
          <Button
            key={next}
            disabled={busy}
            onClick={() => {
              setProvider(next);
              setClientSecret('');
              setSetup({});
            }}
          >
            {t(copy[next].connect)}
          </Button>
        ))}
      </div>
      {failure && (
        <p role="alert" class="text-sm text-danger">
          {t(text.failed)}: {failure === 'account_mismatch' ? t(text.sameAccount) : failure}
        </p>
      )}
      {view.attempt.storage?.warning && (
        <p class="text-sm text-warning">{t('connections.storageWarning')}</p>
      )}
      {view.attempt.state === 'pending' && (
        <p role="status" class="text-sm text-fg-soft">
          {t(text.pending)}
          {consentUrl && (
            <a
              class="ml-2 text-accent hover:underline"
              href={consentUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              {t(text.continue)}
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
              provider,
              action: 'connect',
              input: { ...setup, clientId, ...(clientSecret ? { clientSecret } : {}) },
            });
            setClientSecret('');
          }}
        >
          <p class="text-sm text-fg-soft">{t(text.setup)}</p>
          <label class="block text-sm text-fg-soft">
            {t(text.clientId)}
            <input
              class={FORM_CONTROL_CLASS}
              required
              value={clientId}
              autoComplete="off"
              onInput={(event) => setClientId(event.currentTarget.value)}
            />
          </label>
          {provider === 'google' && (
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
          )}
          <div class="flex gap-2">
            <Button type="submit" disabled={busy}>
              {t(text.continue)}
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
            <div class="min-w-48 flex-1">
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
                      provider: account.provider,
                      action,
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
