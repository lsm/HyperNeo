#!/usr/bin/env bun
import { mkdirSync, readFileSync, writeFileSync, existsSync, appendFileSync } from 'node:fs';
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
              pid: Number(
                readFileSync(join(run, 'evidence/worker-pid'), 'utf8').trim().split('\n').at(-1)
              ),
            },
          ]
        : []
    )
  );
} else if (process.argv.includes('-p') && process.argv.includes('--session-id')) {
  const id = process.argv[process.argv.indexOf('--session-id') + 1];
  const dir = join(home, '.claude/projects', process.cwd().replace(/[/.]/g, '-'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${id}.jsonl`),
    `${JSON.stringify({ type: 'user', uuid: 'synthetic-input', cwd: process.cwd(), timestamp: new Date().toISOString(), message: { content: process.argv.at(-1) } })}\n`
  );
  writeFileSync(state, id);
  appendFileSync(join(run, 'evidence/worker-pid'), `${process.pid}\n`);
  setInterval(() => {}, 1000);
} else process.exit(1);
