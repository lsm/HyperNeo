import { SESSION_CLI_USAGE } from './session-cli-commands.ts';
import { request } from 'node:http';
import { sessionDoorPath } from '@hyperneo/daemon/lib/messaging/session-door';
import { WORKER_REPORT_KINDS } from '@hyperneo/shared/types/worker-report';

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

function post(socketPath: string, body: unknown): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const call = request(
      { socketPath, path: '/', method: 'POST', headers: { 'content-type': 'application/json' } },
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
  const sender = resolveSender(env) ?? (args[0] === 'pair' || args[0] === 'devices' ? 'cli' : null);
  if (!sender) {
    console.error(
      'hyperneo send: no sender. Run it inside a HyperNeo, Codex or Claude Code session (HYPERNEO_SESSION_ID, CODEX_THREAD_ID or CLAUDE_CODE_SESSION_ID).'
    );
    return 1;
  }
  const plan = planSessionCommand(args, sender);
  if ('reason' in plan) {
    console.error(plan.reason);
    return 1;
  }
  const door = env.HYPERNEO_SESSION_DOOR ?? sessionDoorPath();
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
  console.log(JSON.stringify(value, null, 2));
  return value.kind === 'rejected' || value.ok === false || value.health === 'fail' ? 1 : 0;
}
