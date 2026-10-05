import { existsSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { join } from 'node:path';
import { createCodexDesktopAdapter } from '../../drivers/codex-desktop-adapter.ts';
import { createFindWorkOperation } from '../../drivers/find-operation.ts';
import type { WorkAdapter } from '../../drivers/types.ts';
import type { OperationDefinition } from '../../operations/registry.ts';
import { remoteDaemons } from '../../remote-daemons/registry.ts';

function codexDesktopAdapters(): WorkAdapter[] {
  const codexHome = join(homedir(), '.codex');
  const statePath = join(codexHome, 'state_5.sqlite');
  if (!existsSync(statePath)) return [];
  return [
    createCodexDesktopAdapter({
      statePath,
      worktreesDir: join(codexHome, 'worktrees'),
      machine: hostname(),
      now: Date.now,
    }),
  ];
}

export function registerDriverOperations(): OperationDefinition[] {
  const adapters = codexDesktopAdapters();
  return [createFindWorkOperation({ adapters: () => adapters, remote: remoteDaemons })];
}
