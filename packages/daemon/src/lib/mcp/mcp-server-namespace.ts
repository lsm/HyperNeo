export interface ResolveWorkspaceMcpServerNameInput {
  label: string;
  serverName: string;
  reserved: ReadonlySet<string>;
}

export function resolveWorkspaceMcpServerName(input: ResolveWorkspaceMcpServerNameInput): string {
  const { label, serverName, reserved } = input;
  const base = label ? `${label}:${serverName}` : serverName;

  if (!reserved.has(base)) {
    return base;
  }

  let counter = 2;
  while (true) {
    const candidate = `${base}:${counter}`;
    if (!reserved.has(candidate)) {
      return candidate;
    }
    counter += 1;
  }
}
