import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export function startSigningAgent(run: string) {
  const socket = join(run, 'agent.sock');
  const key = join(run, 'signing-key');
  assert.equal(spawnSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'synthetic-signing', '-f', key]).status, 0);
  const agent = spawnSync('ssh-agent', ['-a', socket, '-s'], { encoding: 'utf8' });
  const pid = Number(agent.stdout.match(/SSH_AGENT_PID=(\d+)/)?.[1]);
  assert(pid, agent.stderr);
  assert.equal(spawnSync('ssh-add', ['-q', key], { env: { ...process.env, SSH_AUTH_SOCK: socket } }).status, 0);
  return {
    env: { VERIFY_SIGNING_SOCK: socket, VERIFY_SIGNING_KEY: readFileSync(`${key}.pub`, 'utf8').trim() },
    stop: () => process.kill(pid),
  };
}
