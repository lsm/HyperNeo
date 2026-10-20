import { request } from 'node:http';
import { sessionDoorPath } from '@hyperneo/daemon/lib/messaging/session-door';

type Env = Record<string, string | undefined>;

export const SESSION_CLI_USAGE = `Usage:
  hyperneo send <session-id> <text>   Message another session (inside a HyperNeo, Codex or Claude Code session)
  hyperneo question <question-id>     Read a Neo question and whether the human answered it
  hyperneo build                      Read daemon build and health through the owner-only session socket`;

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
  if (command === 'question' && target && !rest.length)
    return { value: { name: 'neo.question.get', input: { questionId: target } } };
  return { reason: SESSION_CLI_USAGE };
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
  const sender = resolveSender(env);
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
