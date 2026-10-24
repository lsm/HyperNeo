import { parseAcpCommand } from '@hyperneo/shared/acp';

export function parseMcpArgs(value: string): string[] {
  return parseAcpCommand(`mcp ${value}`).args;
}

export function formatMcpArgs(args: string[] = []): string {
  return args
    .map((arg) =>
      /^[^\s"'\\]+$/.test(arg) ? arg : `"${arg.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
    )
    .join(' ');
}
