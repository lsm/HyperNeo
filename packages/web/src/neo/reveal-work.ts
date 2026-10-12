const flash = ['ring-2', 'ring-accent', 'rounded-2xl'];

export function neoWorkAnchorSelector(id: string): string {
  return `[data-neo-work="${id.replace(/["\\]/g, '\\$&')}"]`;
}

export function revealNeoWork(
  root: ParentNode | null | undefined,
  id: string,
  later: (run: () => void, ms: number) => unknown = setTimeout
): boolean {
  const target = root?.querySelector<HTMLElement>(neoWorkAnchorSelector(id));
  if (!target) return false;
  target.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
  target.classList.add(...flash);
  later(() => target.classList.remove(...flash), 1600);
  return true;
}
