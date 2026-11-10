import { request } from 'node:http';
import { dirname, join } from 'node:path';
import { sessionDoorPath } from '@hyperneo/daemon/lib/messaging/session-door';
import { readLocalCredential } from '@hyperneo/daemon/lib/pairing/local-credential';
import { spawnProcess } from '@hyperneo/daemon/lib/runtime-spawn';
import { WORKER_REPORT_KINDS } from '@hyperneo/shared/types/worker-report';
import { runPairQr } from './pair-qr.ts';
import { readCard } from './read-card.ts';
import { SESSION_CLI_USAGE } from './session-cli-commands.ts';

const TAILSCALE = ['tailscale', '/Applications/Tailscale.app/Contents/MacOS/Tailscale'];

async function tailscale(args: string[]): Promise<unknown> {
  for (const command of TAILSCALE) {
    try {
      const child = spawnProcess([command, ...args], {
        stdout: 'pipe',
        stderr: 'ignore',
        env: { ...(process.env as Record<string, string>), TERM: process.env.TERM || 'dumb' },
      });
      const text = await new Response(child.stdout).text();
      if ((await child.exited) === 0) return JSON.parse(text);
    } catch {}
  }
  return null;
}

type Env = Record<string, string | undefined>;

export { SESSION_CLI_USAGE };

export function resolveSender(env: Env): string | null {
  if (env.HYPERNEO_SESSION_ID) return env.HYPERNEO_SESSION_ID;
  if (env.CODEX_THREAD_ID) return `codex-desktop:${env.CODEX_THREAD_ID}`;
  if (env.CLAUDE_CODE_SESSION_ID) return `claude-code:${env.CLAUDE_CODE_SESSION_ID}`;
  return null;
}

export function planSessionCommand(
  args: string[],
  sender: string
): { value: { name: string; input: unknown } } | { reason: string } {
  const [command, target, ...rest] = args;
  if (command === 'relay') {
    const [whereFlag, where, whenFlag, when, separator, ...words] = rest;
    return target &&
      whereFlag === '--where' &&
      where?.trim() &&
      whenFlag === '--when' &&
      when?.trim() &&
      separator === '--' &&
      words.join(' ').trim()
      ? {
          value: {
            name: 'neo.question.relayAnswer',
            input: { questionId: target, where, when, words: words.join(' ') },
          },
        }
      : {
          reason:
            'relay_incomplete: use relay <questionId> --where <place> --when <time> -- <exact words>.',
        };
  }
  if (command === 'send' && target && rest[0] === '--kind') {
    const kind = WORKER_REPORT_KINDS.find((value) => value === rest[1]);
    const text = rest.slice(2).join(' ');
    return kind && text.trim()
      ? { value: { name: 'message.send', input: { to: target, text, kind } } }
      : { reason: SESSION_CLI_USAGE };
  }
  if (command === 'send' && rest.includes('--kind')) return { reason: SESSION_CLI_USAGE };
  if (command === 'send' && target && rest.join(' ').trim())
    return {
      value: {
        name: 'message.send',
        input: {
          to: target,
          text: rest.join(' '),
        },
      },
    };
  if (command === 'build' && !target && !rest.length)
    return { value: { name: 'system.build', input: {} } };
  if (command === 'reserve-restart' && !target && !rest.length)
    return { value: { name: 'system.restart.reserve', input: {} } };
  if (command === 'pair') return planPairCommand(args.slice(1));
  if (command === 'devices' && !target) return { value: { name: 'device.list', input: {} } };
  if (command === 'devices' && target === 'reset-human' && !rest.length)
    return { value: { name: 'device.reset_human', input: {} } };
  if (command === 'devices' && target === 'revoke' && rest.length === 1 && rest[0])
    return { value: { name: 'device.revoke', input: { deviceId: rest[0] } } };
  if (command === 'question' && target && !rest.length)
    return { value: { name: 'neo.question.get', input: { questionId: target } } };
  return { reason: SESSION_CLI_USAGE };
}

function planPairCommand(
  args: string[]
): { value: { name: string; input: unknown } } | { reason: string } {
  if (args.length === 1 && args[0] === '--reset-lockout')
    return { value: { name: 'device.pair.reset_lockout', input: {} } };
  const input: { kind: string; name?: string } = { kind: 'human' };
  for (let i = 0; i < args.length; i += 2) {
    const [flag, value] = [args[i], args[i + 1]];
    if (!value) return { reason: SESSION_CLI_USAGE };
    if (flag === '--kind') input.kind = value;
    else if (flag === '--name') input.name = value;
    else return { reason: SESSION_CLI_USAGE };
  }
  return { value: { name: 'device.pair.create', input } };
}

async function post(socketPath: string, body: unknown): Promise<{ status: number; body: unknown }> {
  const credential = await readLocalCredential(join(dirname(socketPath), 'local-rpc.credential'));
  return new Promise((resolve, reject) => {
    const call = request(
      {
        socketPath,
        path: '/',
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${credential}` },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () =>
          resolve({
            status: response.statusCode ?? 0,
            body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
          })
        );
      }
    );
    call.on('error', reject);
    call.end(JSON.stringify(body));
  });
}

export async function runSessionCommand(args: string[], env: Env = process.env): Promise<number> {
  if (args[0] === 'desktop-mcp') {
    const { runDesktopMcp } = await import('./desktop-mcp.ts');
    await runDesktopMcp(args.slice(1));
    return 0;
  }
  if (args[0] === 'read') return readCard(args.slice(1), env.HYPERNEO_DATA_DIR);
  const sender =
    resolveSender(env) ?? (['pair', 'devices', 'reserve-restart'].includes(args[0]) ? 'cli' : null);
  if (!sender) {
    console.error(
      'hyperneo send: no sender. Run it inside a HyperNeo, Codex or Claude Code session (HYPERNEO_SESSION_ID, CODEX_THREAD_ID or CLAUDE_CODE_SESSION_ID).'
    );
    return 1;
  }
  const door = env.HYPERNEO_SESSION_DOOR ?? sessionDoorPath();
  if (args[0] === 'pair' && args.includes('--qr'))
    return runPairQr(args.slice(1), {
      call: async (name, input) => {
        const reply = await post(door, { sender, name, input }).catch((error: Error) => ({
          body: { error: `the HyperNeo daemon is not reachable at ${door}: ${error.message}` },
        }));
        const { kind, value, error, message } = reply.body as Record<string, unknown>;
        return kind === 'completed' ? value : { ok: false, reason: error ?? message ?? kind };
      },
      tailscale,
      ask: async (question) => prompt(question) ?? '',
      print: (text) => console.log(text),
      now: Date.now,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    });
  const plan = planSessionCommand(args, sender);
  if ('reason' in plan) {
    console.error(plan.reason);
    return 1;
  }
  const reply = await post(door, { sender, ...plan.value }).catch((error: Error) => ({
    status: 0,
    body: { error: `the HyperNeo daemon is not reachable at ${door}: ${error.message}` },
  }));
  const outcome = reply.body as {
    kind?: string;
    value?: unknown;
    error?: string;
    message?: string;
  };
  if (reply.status !== 200 || outcome.kind !== 'completed') {
    console.error(outcome.error ?? outcome.message ?? JSON.stringify(outcome));
    return 1;
  }
  const value = outcome.value as { kind?: string; ok?: boolean; reason?: string; health?: string };
  if (args[0] === 'relay' && value.ok === false) {
    console.error(value.reason);
    return 1;
  }
  console.log(JSON.stringify(value, null, 2));
  return value.kind === 'rejected' || value.ok === false || value.health === 'fail' ? 1 : 0;
}
