export interface GitCheckout {
  repo: string;
  linked: boolean;
}

export type WorkPlacement = { kind: 'in_place' } | { kind: 'worktree'; repo: string };

export function planWorkPlacement(checkout: GitCheckout | null): WorkPlacement {
  return checkout && !checkout.linked
    ? { kind: 'worktree', repo: checkout.repo }
    : { kind: 'in_place' };
}
