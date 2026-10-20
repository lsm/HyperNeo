import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const copilotFixture = fileURLToPath(new URL('../fixtures/copilot-acp.ts', import.meta.url));
export const copilotFolder = '/synthetic/copilot-project';
export const copilotSession = '11111111-1111-4111-8111-111111111111';

export function prepareCopilotFixture(run: string) {
  const root = realpathSync(resolve(run));
  const home = join(root, 'home');
  mkdirSync(join(home, 'evidence'), { recursive: true });
  const state = join(home, '.copilot/session-state', copilotSession);
  mkdirSync(state, { recursive: true });
  writeFileSync(
    join(state, 'events.jsonl'),
    JSON.stringify({ type: 'session.start', data: { context: { cwd: copilotFolder } } }) + '\n'
  );
  const bin = join(root, 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(
    join(bin, 'copilot'),
    `#!/usr/bin/env bun\nawait import(${JSON.stringify(copilotFixture)});\n`,
    { mode: 0o700 }
  );
  return { home, bin };
}
