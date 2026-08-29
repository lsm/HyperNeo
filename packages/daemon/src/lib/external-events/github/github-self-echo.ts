export type SelfEchoVerdict = 'admit' | 'drop';

export function decideSelfEchoFilter({
  actorLogin,
  filteredLogins,
  enabled,
}: {
  actorLogin: string;
  filteredLogins: string[];
  enabled: boolean;
}): SelfEchoVerdict {
  if (!enabled) return 'admit';
  const normalized = actorLogin.toLowerCase();
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
