const KINDS = new Set(['done', 'blocked', 'question', 'failed']);
const BARE = /^[^\s'"`$\\;&|<>(){}*?[\]!#~]+$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9:._@/-]*$/;

function words(command: string): string[] | undefined {
  if (/[\r\n\0]/.test(command)) return undefined;
  const out: string[] = [];
  let rest = command.trim();
  while (rest) {
    const match =
      rest.match(/^"([^"`$\\!]*)"(?=\s|$)/) ??
      rest.match(/^'([^']*)'(?=\s|$)/) ??
      rest.match(/^(\S+)(?=\s|$)/);
    if (!match) return undefined;
    if (match[0] === match[1] && !BARE.test(match[1])) return undefined;
    out.push(match[1]);
    rest = rest.slice(match[0].length).trimStart();
  }
  return out;
}

export function isHyperneoSendCommand(command: string): boolean {
  const parts = words(command);
  if (!parts || parts[0] !== 'hyperneo' || parts[1] !== 'send' || !ID.test(parts[2] ?? ''))
    return false;
  const seen = new Set<string>();
  let index = 3;
  while (parts[index] === '--from' || parts[index] === '--kind') {
    const [flag, value = ''] = [parts[index], parts[index + 1]];
    if (seen.has(flag)) return false;
    seen.add(flag);
    if (flag === '--from' ? !ID.test(value) : !KINDS.has(value)) return false;
    index += 2;
  }
  return seen.has('--from') && index < parts.length && !parts[index].startsWith('-');
}
