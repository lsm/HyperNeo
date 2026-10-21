#!/usr/bin/env bun
import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
const home = process.env.HOME!;
const run = join(home, '..');
const state = join(run, 'evidence/worker-session');
const flag = (name: string) => process.argv[process.argv.indexOf(name) + 1];
const turn = (id: string) => {
  const dir = join(home, '.claude/projects', process.cwd().replace(/[/.]/g, '-'));
  mkdirSync(dir, { recursive: true });
  appendFileSync(
    join(dir, `${id}.jsonl`),
    `${JSON.stringify({ type: 'user', uuid: `synthetic-${Date.now()}`, cwd: process.cwd(), entrypoint: 'sdk-cli', permissionMode: flag('--permission-mode'), timestamp: new Date().toISOString(), message: { content: process.argv.at(-1) } })}\n`
  );
  appendFileSync(
    join(run, 'evidence/cli-inputs'),
    `${flag('--permission-mode')} ${process.argv.at(-1)}\n`
  );
};
if (process.argv.includes('agents')) process.stdout.write('[]');
else if (process.argv.includes('-p') && process.argv.includes('--session-id')) {
  writeFileSync(state, flag('--session-id'));
  turn(flag('--session-id'));
} else if (process.argv.includes('-p') && process.argv.includes('--resume')) turn(flag('--resume'));
else process.exit(1);
