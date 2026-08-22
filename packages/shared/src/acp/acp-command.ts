export function getAcpCommandIdentity(commandLine: string): string {
  const { command, args } = parseAcpCommand(commandLine);
  return JSON.stringify([command, ...args]);
}

export function parseAcpCommand(commandLine: string): { command: string; args: string[] } {
  const tokens: string[] = [];
  let current = '';
  let quote: 'single' | 'double' | null = null;
  let escaping = false;
  let tokenStarted = false;

  const trimmedCommand = commandLine.trim();
  for (let index = 0; index < trimmedCommand.length; index++) {
    const char = trimmedCommand[index];
    if (escaping) {
      current += char;
      escaping = false;
      tokenStarted = true;
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
        tokenStarted = true;
      }
      continue;
    }

    if (char === "'" && quote !== 'double') {
      quote = quote === 'single' ? null : 'single';
      tokenStarted = true;
      continue;
    }

    if (char === '"' && quote !== 'single') {
      quote = quote === 'double' ? null : 'double';
      tokenStarted = true;
      continue;
    }

    if (/\s/.test(char) && !quote) {
      if (tokenStarted) {
        tokens.push(current);
        current = '';
        tokenStarted = false;
      }
      continue;
    }

    current += char;
    tokenStarted = true;
  }

  if (escaping) {
    current += '\\';
    tokenStarted = true;
  }
  if (quote) {
    throw new Error('Invalid ACP command: unmatched quote');
  }
  if (tokenStarted) tokens.push(current);
  if (!tokens[0]) {
    throw new Error('Invalid ACP command: command is empty');
  }

  return { command: tokens[0], args: tokens.slice(1) };
}
