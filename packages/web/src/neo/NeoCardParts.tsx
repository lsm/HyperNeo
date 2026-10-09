import { ProviderLogo } from '../components/ProviderLogo.tsx';
import { providerLogoColor } from '../lib/provider-brand.ts';
import { NeoIcon } from './NeoIcon.tsx';

export const neoCardClass = 'neo-arrive rounded-2xl border border-line bg-surface p-4 shadow-sm';

export const neoFooterClass = 'mt-3 flex flex-wrap items-center gap-2 border-t border-line pt-3';

export const neoSecondaryClass =
  'inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-line px-2.5 py-1.5 text-xs font-semibold text-fg hover:border-accent/40 hover:text-accent focus-visible:outline-accent';

export const neoPrimaryClass =
  'inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-accent-hover px-3 py-1.5 text-xs font-semibold text-accent-fg shadow-sm hover:shadow focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-50';

export const neoPlainClass =
  'inline-flex shrink-0 items-center gap-1 rounded-lg px-2 py-1.5 text-xs font-medium text-fg-muted hover:bg-fill-soft hover:text-fg disabled:cursor-not-allowed disabled:opacity-50';

export function NeoStatusChip({
  tone,
  colors,
  label,
  pulse = false,
}: {
  tone: string;
  colors: string;
  label: string;
  pulse?: boolean;
}) {
  return (
    <span
      data-tone={tone}
      class={`inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold ${colors}`}
    >
      <span
        aria-hidden="true"
        class={`h-1.5 w-1.5 shrink-0 rounded-full bg-current${pulse ? ' motion-safe:animate-pulse' : ''}`}
      />
      <span class="truncate">{label}</span>
    </span>
  );
}

export function NeoAppMark({ logo }: { logo: string | undefined }) {
  return logo ? (
    <span data-app-logo={logo} class="flex" style={{ color: providerLogoColor(logo) }}>
      <ProviderLogo provider={logo} class="h-3.5 w-3.5" />
    </span>
  ) : (
    <NeoIcon name="external" class="!h-3.5 !w-3.5" />
  );
}

export function NeoChatMark() {
  return <NeoIcon name="spark" class="!h-3.5 !w-3.5 text-accent" />;
}

export function NeoMoreIcon() {
  return (
    <svg class="h-4 w-4" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="5" cy="12" r="1.75" />
      <circle cx="12" cy="12" r="1.75" />
      <circle cx="19" cy="12" r="1.75" />
    </svg>
  );
}
