#!/usr/bin/env bun
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
const home = process.env.HOME!;
const run = join(home, '..');
const state = join(run, 'evidence/worker-session');
if (process.argv.includes('agents')) {
  process.stdout.write(
    JSON.stringify(
      existsSync(state)
        ? [
            {
              sessionId: readFileSync(state, 'utf8'),
              status: 'busy',
              pid: Number(readFileSync(join(run, 'evidence/worker-pid'), 'utf8')),
            },
          ]
        : []
    )
  );
} else if (process.argv.includes('-p')) {
  const id = process.argv[process.argv.indexOf('--session-id') + 1];
  const dir = join(home, '.claude/projects', process.cwd().replace(/[/.]/g, '-'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${id}.jsonl`),
    `${JSON.stringify({ type: 'user', uuid: 'synthetic-input', cwd: process.cwd(), timestamp: new Date().toISOString(), message: { content: process.argv.at(-1) } })}\n`
  );
  writeFileSync(state, id);
  writeFileSync(join(run, 'evidence/worker-pid'), String(process.pid));
  setInterval(() => {}, 1000);
} else process.exit(1);
