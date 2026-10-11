import {
  type NeoWorkPr,
  type NeoWorkPrReceipt,
  neoWorkPrVerdict,
} from '@hyperneo/shared/types/neo-snapshot';

const stuck = (pr: NeoWorkPr) => pr.state === 'OPEN' && neoWorkPrVerdict(pr) === 'failed';

export function neoWorkPrInProgress(receipt: NeoWorkPrReceipt | undefined): boolean {
  const prs = receipt?.prs ?? [];
  return prs.some((pr) => pr.state === 'OPEN') && !prs.some(stuck);
}

export function neoWorkPrSetback(receipt: NeoWorkPrReceipt | undefined): boolean {
  const prs = receipt?.prs ?? [];
  return prs.some((pr) => neoWorkPrVerdict(pr) === 'failed');
}

function headlinePr(receipt: NeoWorkPrReceipt | undefined): NeoWorkPr | undefined {
  const prs = receipt?.prs ?? [];
  return prs.find(stuck) ?? prs.find((candidate) => candidate.state === 'OPEN') ?? prs[0];
}

const prNumber = (pr: NeoWorkPr) => `#${pr.url.split('/').pop() ?? pr.url}`;

export function neoWorkPrNumbers(
  receipt: NeoWorkPrReceipt | undefined,
  state: NeoWorkPr['state']
): string[] {
  return (receipt?.prs ?? []).filter((pr) => pr.state === state).map(prNumber);
}

export function neoWorkPrNumber(receipt: NeoWorkPrReceipt | undefined): string | null {
  const pr = headlinePr(receipt);
  return pr ? prNumber(pr) : null;
}

export function neoWorkPrLabel(receipt: NeoWorkPrReceipt | undefined): string | null {
  const prs = receipt?.prs ?? [];
  const pr = headlinePr(receipt);
  if (!pr) return null;
  const number = prNumber(pr);
  const more = prs.length > 1 ? ` +${prs.length - 1}` : '';
  const state = {
    done: 'Merged',
    failed:
      pr.state === 'CLOSED'
        ? 'PR closed'
        : pr.checks === 'failing'
          ? 'Checks failing'
          : 'Changes requested',
    waiting: 'Waiting on CI',
    ready: 'Approved, not merged',
    pending: 'Waiting on review',
  }[neoWorkPrVerdict(pr)];
  return `${state} · ${number}${more}`;
}
