import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

export const ClaudeDesktopRecordSchema = z.object({
  sessionId: z.string().startsWith('local_'),
  cliSessionId: z.string().optional(),
  originCwd: z.string().optional(),
  cwd: z.string().optional(),
  title: z.string().default(''),
  isArchived: z.boolean().default(false),
  lastActivityAt: z.number().default(0),
  permissionMode: z.string().optional(),
  remoteControlUserEnabled: z.boolean().optional(),
  bridgeSessionIds: z.array(z.string()).optional(),
  prs: z
    .array(
      z.object({ url: z.string(), dismissed: z.boolean().optional(), own: z.boolean().optional() })
    )
    .optional()
    .catch(undefined),
  branch: z.string().optional().catch(undefined),
  writtenBranches: z.array(z.string()).optional().catch(undefined),
});

export type ClaudeDesktopRecord = z.infer<typeof ClaudeDesktopRecordSchema> & {
  desktopRegistered?: true;
};

const records = new Map<string, { at: number; record: ClaudeDesktopRecord | null }>();

function listDir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function readRecord(path: string): ClaudeDesktopRecord | null {
  try {
    const at = statSync(path).mtimeMs;
    const known = records.get(path);
    if (known?.at === at) return known.record;
    const parsed = ClaudeDesktopRecordSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')));
    const record = parsed.success ? { ...parsed.data, desktopRegistered: true as const } : null;
    records.set(path, { at, record });
    return record;
  } catch {
    records.delete(path);
    return null;
  }
}

export function readClaudeDesktopRecordFiles(sessionsDir: string): ClaudeDesktopRecord[] {
  const files = listDir(sessionsDir).flatMap((account) =>
    listDir(join(sessionsDir, account)).flatMap((scope) =>
      listDir(join(sessionsDir, account, scope))
        .filter((name) => name.startsWith('local_') && name.endsWith('.json'))
        .map((name) => join(sessionsDir, account, scope, name))
    )
  );
  const present = new Set(files);
  for (const path of records.keys()) if (!present.has(path)) records.delete(path);
  return files.flatMap((path) => readRecord(path) ?? []);
}
