import type { NeoWorkPr, NeoWorkPrReceipt } from '@hyperneo/shared/types/neo-snapshot';

const stuck = (pr: NeoWorkPr) =>
  pr.state === 'OPEN' && (pr.checks === 'failing' || pr.review === 'changes_requested');

export function neoWorkPrInProgress(receipt: NeoWorkPrReceipt | undefined): boolean {
  const prs = receipt?.prs ?? [];
  return prs.some((pr) => pr.state === 'OPEN') && !prs.some(stuck);
}

export function neoWorkPrLabel(receipt: NeoWorkPrReceipt | undefined): string | null {
  const prs = receipt?.prs ?? [];
  const pr = prs.find(stuck) ?? prs.find((candidate) => candidate.state === 'OPEN') ?? prs[0];
  if (!pr) return null;
  const number = `#${pr.url.split('/').pop() ?? pr.url}`;
  const more = prs.length > 1 ? ` +${prs.length - 1}` : '';
  const state =
    pr.state === 'MERGED'
      ? 'Merged'
      : pr.state === 'CLOSED'
        ? 'PR closed'
        : pr.checks === 'failing'
          ? 'Checks failing'
          : pr.review === 'changes_requested'
            ? 'Changes requested'
            : pr.checks === 'pending'
              ? 'Waiting on CI'
              : pr.review === 'approved'
                ? 'Approved, not merged'
                : 'Waiting on review';
  return `${state} · ${number}${more}`;
}
