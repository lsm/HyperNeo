export function parseAcpCommand(commandLine: string): { command: string; args: string[] } {
  const tokens: string[] = [];
  let current = '';
  let quote: 'single' | 'double' | null = null;
  let escaping = false;

  for (const char of commandLine.trim()) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }

    if (char === '\\') {
      escaping = true;
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
    throw new Error('Invalid HYPERNEO_ACP_COMMAND: unmatched quote');
  }
  if (current) tokens.push(current);
  if (tokens.length === 0) {
    throw new Error('Invalid HYPERNEO_ACP_COMMAND: command is empty');
  }

  return { command: tokens[0], args: tokens.slice(1) };
}
