import { useEffect, useRef, useState } from 'preact/hooks';
import { Button } from '../components/ui/Button.tsx';
import { connectionManager } from '../lib/connection-manager.ts';
import { t } from '../lib/i18n/index.ts';
import { invokeOperation } from '../lib/operations.ts';
import { type NeoSpeechPlayer, openNeoSpeechPlayer } from '../lib/voice/neo-speech-player.ts';
import { NeoIcon } from './NeoIcon.tsx';

type Receipt = { ok: boolean; reason?: string };

export function NeoRealtimeVoice({
  collapsed,
  sessionId,
  connected,
  onError,
}: {
  collapsed: boolean;
  sessionId: string;
  connected: boolean;
  onError: (message: string) => void;
}) {
  const [on, setOn] = useState(false);
  const live = useRef<{ player: NeoSpeechPlayer; stop: (disable: boolean) => void } | null>(null);
  const disabling = useRef<Promise<unknown> | null>(null);

  const stop = (disable = true) => {
    live.current?.stop(disable);
    live.current = null;
    setOn(false);
  };

  useEffect(() => {
    if (!connected) stop();
  }, [connected]);
  useEffect(() => stop, [sessionId]);

  const start = async () => {
    const hub = connectionManager.getHubIfConnected();
    if (!hub) return onError(t('composer.reconnecting'));
    let current = !disabling.current;
    disabling.current?.then(() => {
      current = true;
    });
    const player = openNeoSpeechPlayer(hub, sessionId, {
      onStop: () => {
        if (live.current === session && current) stop(false);
      },
    });
    const session = {
      player,
      stop: (disable: boolean) => {
        player.close();
        if (disable)
          disabling.current = invokeOperation(hub, 'neo.speech.listen', {
            sessionId,
            enabled: false,
          }).catch(() => {});
      },
    };
    live.current = session;
    const refuse = (receipt: Receipt) => {
      player.close();
      if (live.current === session) live.current = null;
      onError(
        t(
          receipt.reason === 'speech_backend_not_configured'
            ? 'composer.voiceRepliesNotConfigured'
            : 'composer.voiceRepliesUnavailable'
        )
      );
    };
    try {
      const catalog = await invokeOperation<Receipt>(hub, 'neo.speech.catalog', {});
      if (live.current !== session) return;
      if (!catalog.ok) return refuse(catalog);
      const listen = await invokeOperation<Receipt>(hub, 'neo.speech.listen', {
        sessionId,
        enabled: true,
        audio: true,
      });
      if (live.current !== session) return;
      if (!listen.ok) return refuse(listen);
      setOn(true);
    } catch {
      if (live.current === session) refuse({ ok: false });
    }
  };

  const label = t(on ? 'composer.realtimeVoiceStop' : 'composer.realtimeVoice');
  return (
    <Button
      type="button"
      variant={on ? 'primary' : 'ghost'}
      size="sm"
      aria-label={label}
      aria-pressed={on}
      title={label}
      disabled={!connected}
      onClick={() => (live.current ? stop() : void start())}
      class="h-11 w-11 min-w-11 shrink-0 px-0 !rounded-full"
    >
      <NeoIcon name="voice" class={collapsed ? '!size-6' : '!size-7'} />
    </Button>
  );
}
