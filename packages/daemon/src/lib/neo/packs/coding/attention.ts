import type { NeoAttentionEvent, NeoAttentionKind } from '../../attention/decide.ts';

export type CodingAttend = (event: NeoAttentionEvent) => Promise<boolean>;

const told = {
  decide: () => 'wake' as const,
  render: ({ facts }: NeoAttentionEvent) => String(facts.text),
};

export const CODING_ATTENTION_KINDS: readonly NeoAttentionKind[] = [
  { id: 'coding.merge_held', ...told },
  { id: 'coding.merge_failing', ...told, ladder: [4 * 3_600_000] },
  { id: 'coding.merge_confirmed', ...told },
];

export const codingPrHeadEvent = (
  kind: string,
  pr: { url: string; head: string },
  since: number,
  text: string
): NeoAttentionEvent => ({
  kind,
  subject: { type: 'pr_head', id: `${pr.url}@${pr.head}` },
  since,
  facts: { text },
});
