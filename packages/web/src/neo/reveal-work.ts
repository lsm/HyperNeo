const flash = ['ring-2', 'ring-accent', 'rounded-2xl'];

export function neoWorkAnchorSelector(id: string): string {
  return `[data-neo-work="${id.replace(/["\\]/g, '\\$&')}"]`;
}

export function neoAskAnchorSelector(id: string): string {
  return `[data-ask="${id.replace(/["\\]/g, '\\$&')}"]`;
}

export function revealNeoAsk(
  root: ParentNode | null | undefined,
  id: string,
  later: (run: () => void, ms: number) => unknown = setTimeout
): boolean {
  return revealNeoTarget(root?.querySelector<HTMLElement>(neoAskAnchorSelector(id)), later);
}

export function revealNeoWork(
  root: ParentNode | null | undefined,
  id: string,
  later: (run: () => void, ms: number) => unknown = setTimeout
): boolean {
  return revealNeoTarget(root?.querySelector<HTMLElement>(neoWorkAnchorSelector(id)), later);
}

function revealNeoTarget(
  target: HTMLElement | null | undefined,
  later: (run: () => void, ms: number) => unknown
): boolean {
  if (!target) return false;
  target.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
  target.classList.add(...flash);
  later(() => target.classList.remove(...flash), 1600);
  return true;
}
