export interface AcpCommandTokenSpan {
  start: number;
  end: number;
}

export interface ParsedAcpCommandWithSpans {
  command: string;
  args: string[];
  rawSpans: AcpCommandTokenSpan[];
}

export function getAcpCommandIdentity(commandLine: string): string {
  const { command, args } = parseAcpCommand(commandLine);
  return JSON.stringify([command, ...args]);
}

export function parseAcpCommand(commandLine: string): { command: string; args: string[] } {
  const { command, args } = parseAcpCommandWithSpans(commandLine);
  return { command, args };
}

export function parseAcpCommandWithSpans(commandLine: string): ParsedAcpCommandWithSpans {
  const tokens: string[] = [];
  const rawSpans: AcpCommandTokenSpan[] = [];
  let current = '';
  let quote: 'single' | 'double' | null = null;
  let escaping = false;
  let tokenStarted = false;
  let rawStart = 0;
  let rawEnd = 0;

  const trimmedCommand = commandLine.trim();
  const base = commandLine.length - commandLine.trimStart().length;

  const pushToken = () => {
    tokens.push(current);
    rawSpans.push({ start: rawStart, end: rawEnd });
    current = '';
    tokenStarted = false;
  };

  for (let index = 0; index < trimmedCommand.length; index++) {
    if (escaping) {
      current += trimmedCommand[index];
      rawEnd = base + index + 1;
      escaping = false;
      tokenStarted = true;
      continue;
    }

    const char = trimmedCommand[index];
    if (char === '\\') {
      const next = trimmedCommand[index + 1];
      if (
        next !== undefined &&
        (/\s/.test(next) || next === "'" || next === '"' || next === '\\')
      ) {
        if (!tokenStarted) {
          tokenStarted = true;
          rawStart = base + index;
        }
        rawEnd = base + index + 1;
        escaping = true;
      } else {
        if (!tokenStarted) {
          tokenStarted = true;
          rawStart = base + index;
        }
        current += char;
        rawEnd = base + index + 1;
      }
      continue;
    }

    if (char === "'" && quote !== 'double') {
      if (!tokenStarted) {
        tokenStarted = true;
        rawStart = base + index;
      }
      rawEnd = base + index + 1;
      quote = quote === 'single' ? null : 'single';
      continue;
    }

    if (char === '"' && quote !== 'single') {
      if (!tokenStarted) {
        tokenStarted = true;
        rawStart = base + index;
      }
      rawEnd = base + index + 1;
      quote = quote === 'double' ? null : 'double';
      continue;
    }

    if (/\s/.test(char) && !quote) {
      if (tokenStarted) {
        pushToken();
      }
      continue;
    }

    if (!tokenStarted) {
      tokenStarted = true;
      rawStart = base + index;
    }
    current += char;
    rawEnd = base + index + 1;
  }

  if (escaping) {
    current += '\\';
    tokenStarted = true;
  }
  if (quote) {
    throw new Error('Invalid ACP command: unmatched quote');
  }
  if (tokenStarted) pushToken();
  if (!tokens[0]) {
    throw new Error('Invalid ACP command: command is empty');
  }

  return { command: tokens[0], args: tokens.slice(1), rawSpans };
}
