export type SelfEchoVerdict = 'admit' | 'drop';

export function decideSelfEchoFilter({
  initiatorLogin,
  filteredLogins,
  enabled,
}: {
  initiatorLogin: string;
  filteredLogins: string[];
  enabled: boolean;
}): SelfEchoVerdict {
  if (!enabled) return 'admit';
  if (!initiatorLogin) return 'admit';
  const normalized = initiatorLogin.toLowerCase();
  for (const login of filteredLogins) {
    if (login.toLowerCase() === normalized) return 'drop';
  }
  return 'admit';
}

export function resolveFilteredLogins({
  filterCurrentUser,
  tokenLogin,
}: {
  filterCurrentUser: boolean;
  tokenLogin: string;
}): string[] {
  return filterCurrentUser && tokenLogin ? [tokenLogin] : [];
}
