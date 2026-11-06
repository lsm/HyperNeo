import { parseCommand } from '@hyperneo/shared/command';

export function parseMcpArgs(value: string): string[] {
  return parseCommand(`mcp ${value}`).args;
}

export function formatMcpArgs(args: string[] = []): string {
  return args
    .map((arg) =>
      /^[^\s"'\\]+$/.test(arg) ? arg : `"${arg.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
    )
    .join(' ');
}
