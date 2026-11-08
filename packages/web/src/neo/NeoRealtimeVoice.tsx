import { Button } from '../components/ui/Button.tsx';
import { t } from '../lib/i18n/index.ts';
import { NeoIcon } from './NeoIcon.tsx';

export function NeoRealtimeVoice({ collapsed }: { collapsed: boolean }) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      aria-label={t('composer.realtimeVoice')}
      aria-disabled="true"
      title={t('composer.realtimeVoice')}
      class="h-11 w-11 min-w-11 shrink-0 px-0 !rounded-full"
    >
      <NeoIcon name="voice" class={collapsed ? '!size-6' : '!size-7'} />
    </Button>
  );
}
