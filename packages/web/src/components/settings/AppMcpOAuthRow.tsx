import { useEffect, useState } from 'preact/hooks';
import type { AppMcpServer } from '@hyperneo/shared';
import { connectionManager } from '../../lib/connection-manager';
import { isDesktopLinkHost, openExternalLink } from '../../lib/external-links.ts';
import { t } from '../../lib/i18n/index.ts';
import { invokeOperation } from '../../lib/operations.ts';
import { Button } from '../ui/Button.tsx';

type Status = { health: 'healthy' | 'disconnected' | 'reconnect_needed'; preset?: string };
type Receipt = { authorizeUrl?: string; reason?: string; ok?: boolean };
type Action = 'mcp.registry.connect' | 'mcp.registry.reconnect' | 'mcp.registry.disconnect';

const call = async <T,>(name: Action | 'mcp.registry.status', input: unknown) =>
  invokeOperation<T>(await connectionManager.getHub(), name, input);

export function AppMcpOAuthRow({ server }: { server: AppMcpServer }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const { id, auth } = server;
  useEffect(() => {
    let current = true;
    call<Status>('mcp.registry.status', { id }).then(
      (next) => current && setStatus(next),
      (failure: unknown) => current && setError(String(failure))
    );
    return () => {
      current = false;
    };
  }, [id, server.url, auth?.generation, auth?.active]);
  if (!auth && !status?.preset) return null;

  const act = async (name: Action, input: Record<string, string>) => {
    setBusy(true);
    setError('');
    const desktop = isDesktopLinkHost();
    const popup =
      !desktop && name !== 'mcp.registry.disconnect' ? window.open('about:blank', '_blank') : null;
    if (popup) popup.opener = null;
    try {
      const receipt = await call<Receipt>(name, { id, ...input });
      if (receipt.authorizeUrl) {
        if (desktop) openExternalLink(receipt.authorizeUrl);
        else if (popup) popup.location.href = receipt.authorizeUrl;
        return;
      }
      if (receipt.reason) setError(receipt.reason);
    } catch (failure) {
      setError(String(failure));
    } finally {
      setBusy(false);
    }
    popup?.close();
  };

  return (
    <div class="mt-2 flex flex-wrap items-center gap-2" data-testid={`mcp-oauth-${server.name}`}>
      {status && <span class="text-xs text-fg-soft">{t(`connections.${status.health}`)}</span>}
      {!auth && status?.preset ? (
        <Button
          variant="secondary"
          size="sm"
          disabled={busy}
          onClick={() => void act('mcp.registry.connect', { preset: status.preset ?? '' })}
        >
          {t('connections.connectMcp')}
        </Button>
      ) : (
        <Button
          variant="secondary"
          size="sm"
          disabled={busy}
          onClick={() => void act('mcp.registry.reconnect', {})}
        >
          {t('connections.reconnect')}
        </Button>
      )}
      {auth?.active && (
        <Button
          variant="secondary"
          size="sm"
          disabled={busy}
          onClick={() => void act('mcp.registry.disconnect', {})}
        >
          {t('connections.disconnect')}
        </Button>
      )}
      {error && (
        <p role="alert" class="w-full text-xs text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
