import type { NeoQuestionSource } from '@hyperneo/shared/types/neo-ask';
import { useEffect, useState } from 'preact/hooks';
import { connectionManager } from '../lib/connection-manager.ts';
import { t } from '../lib/i18n/index.ts';
import { invokeOperation } from '../lib/operations.ts';
import { NeoSessionOpen } from './NeoCardParts.tsx';
import { neoSessionKind } from './work-driver.ts';

export function NeoPublicationSession({
  session,
  onOpen,
}: {
  session: string;
  onOpen: (link: string, label: string) => void;
}) {
  const [source, setSource] = useState<NeoQuestionSource | null>();
  useEffect(() => {
    let current = true;
    void connectionManager
      .getHub()
      .then((hub) =>
        invokeOperation<NeoQuestionSource | null | { ok: false; reason: string }>(
          hub,
          'neo.session.link',
          { session }
        )
      )
      .then((value) => {
        if (current) setSource(value && 'link' in value ? value : null);
      })
      .catch(() => {
        if (current) setSource(null);
      });
    return () => {
      current = false;
    };
  }, [session]);
  return (
    <NeoSessionOpen
      kind={source ? neoSessionKind(source.adapter, source.link) : null}
      label={t('question.openSessionTitle', { name: source?.name ?? session })}
      disabled={!source?.link}
      busy={source === undefined}
      title={source !== undefined && !source?.link ? t('session.loadFailed') : undefined}
      onOpen={() => {
        if (source?.link) onOpen(source.link, source.label);
      }}
    />
  );
}
