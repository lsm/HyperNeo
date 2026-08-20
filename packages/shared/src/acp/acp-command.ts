export function getAcpCommandIdentity(commandLine: string): string {
  const { command, args } = parseAcpCommand(commandLine);
  return JSON.stringify([command, ...args]);
}

export function parseAcpCommand(commandLine: string): { command: string; args: string[] } {
  const tokens: string[] = [];
  let current = '';
  let quote: 'single' | 'double' | null = null;
  let escaping = false;

  const trimmedCommand = commandLine.trim();
  for (let index = 0; index < trimmedCommand.length; index++) {
    const char = trimmedCommand[index];
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }

    if (char === '\\') {
      const next = trimmedCommand[index + 1];
      if (
        next !== undefined &&
        (/\s/.test(next) || next === "'" || next === '"' || next === '\\')
      ) {
        escaping = true;
      } else {
        current += char;
      }
      continue;
    }

    if (char === "'" && quote !== 'double') {
      quote = quote === 'single' ? null : 'single';
      continue;
    }

    if (char === '"' && quote !== 'single') {
      quote = quote === 'double' ? null : 'double';
      continue;
    }

    if (/\s/.test(char) && !quote) {
      if (current) {
        tokens.push(current);
        current = '';
      }
      continue;
    }

    current += char;
  }

  if (escaping) current += '\\';
  if (quote) {
    throw new Error('Invalid ACP command: unmatched quote');
  }
  if (current) tokens.push(current);
  if (tokens.length === 0) {
    throw new Error('Invalid ACP command: command is empty');
  }

  return { command: tokens[0], args: tokens.slice(1) };
}
