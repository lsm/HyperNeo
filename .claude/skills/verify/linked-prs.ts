import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  type ClaudeDesktopAdapterDeps,
  describeClaudeSession,
  loadClaudeDesktopRecords,
} from '../../../packages/daemon/src/lib/drivers/claude-desktop-adapter.ts';
import { readCodexThread } from '../../../packages/daemon/src/lib/drivers/codex-desktop-adapter.ts';

const [kind, id] = process.argv.slice(2);
if (kind === 'claude' && id) {
  const deps = {
    sessionsDir: join(homedir(), 'Library/Application Support/Claude/claude-code-sessions'),
    machine: 'verify',
  } as ClaudeDesktopAdapterDeps;
  const record = (await loadClaudeDesktopRecords(deps, new Map())).find(
    (item) => item.sessionId === id
  );
  if (!record) throw new Error(`no Claude Desktop session ${id}`);
  const detail = describeClaudeSession(record, [], null, deps);
  console.log(JSON.stringify(detail.ok ? (detail.value.linkedPrs ?? []) : detail, null, 1));
} else if (kind === 'codex' && id) {
  console.log(JSON.stringify(readCodexThread(join(homedir(), '.codex/state_5.sqlite'), id)?.linkedPrs ?? null));
} else {
  console.log('usage: bun .claude/skills/verify/linked-prs.ts claude <local_id> | codex <thread_id>');
}
