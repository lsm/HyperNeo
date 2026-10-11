import type { NeoCardView } from '@hyperneo/shared/types/neo-snapshot';

export type NeoWorkPrimary =
  | { readonly kind: 'start'; readonly label: string }
  | { readonly kind: 'retry'; readonly label: string }
  | { readonly kind: 'close'; readonly label: string; readonly link: string | null }
  | { readonly kind: 'answer'; readonly label: string; readonly link: string | null }
  | { readonly kind: 'open'; readonly label: string; readonly link: string }
  | { readonly kind: 'chat'; readonly label: string }
  | { readonly kind: 'none' };

export function neoWorkPresentation(
  card: NeoCardView | undefined,
  { compact, attention }: { compact: boolean; attention: boolean }
): 'summary' | 'detail' {
  if (!compact || attention) return 'detail';
  const kind = card?.primary.kind;
  return kind === 'retry' || kind === 'close' ? 'detail' : 'summary';
}
