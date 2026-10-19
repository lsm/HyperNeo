import { z } from 'zod';

const NeoWorkBlockerSchema = z.object({
  kind: z.enum(['environment', 'needs_human']),
  what: z.string().trim().min(1).max(500),
});
export type NeoWorkBlocker = z.infer<typeof NeoWorkBlockerSchema>;

export const NEO_WORK_REPORT_LIMIT = 12_000;

function neoWorkBlockerLine(blocker: NeoWorkBlocker): string {
  return `Blocked (${blocker.kind}): ${blocker.what.replace(/\s+/g, ' ').trim()}`;
}

export function withNeoWorkBlocker(report: string, blocker: NeoWorkBlocker): string {
  const line = `\n\n${neoWorkBlockerLine(blocker)}`;
  return `${report.trimEnd().slice(0, Math.max(0, NEO_WORK_REPORT_LIMIT - line.length))}${line}`;
}
