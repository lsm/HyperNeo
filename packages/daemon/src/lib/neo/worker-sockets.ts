import { isAbsolute, join } from 'node:path';
import { homedir } from 'node:os';
import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import { execFile } from 'node:child_process';
import { defineOperation, type OperationCaller } from '../operations/registry.ts';
import type { NeoService } from './service.ts';

const output = (command: string[]) =>
  new Promise<string>((resolve) => {
    execFile(command[0], command.slice(1), { maxBuffer: 16384 }, (error, stdout) =>
      resolve(error ? '' : stdout.trim())
    );
  });

export function workerSocketOperation(
  service: NeoService,
  admit: (
    caller: OperationCaller
  ) => { value: OperationCaller } | { reason: { ok: false; reason: string } }
) {
  return defineOperation({
    name: 'neo.workerSocket.ask',
    description:
      'When a worker reports a blocked Unix socket, request human approval for that exact absolute socket path. Workers cannot change the allowlist. Repeated requests return the original card, including a recorded Decline.',
    inputSchema: z
      .object({
        socket: z.string().refine((path) => isAbsolute(path) && !/[\0\r\n]/.test(path)),
      })
      .strict(),
    resultSchema: z.unknown(),
    policy: { safetyClass: 'mutate', roles: ['neo'] },
    execute: (superpipe({})('neo.workerSocket.ask') as PipelineAPI)
      .input(['input', 'caller'])
      .pipe(admit, 'caller', 'result:outcome')
      .pipe(
        (input: { socket: string }) => service.requestWorkerSocket(input.socket),
        ['input', 'outcome'],
        'outcome'
      )
      .endAsync('outcome'),
  });
}

export const discoverSigningSocket = (superpipe({})('workerSocket.discover') as PipelineAPI)
  .pipe(
    async () => {
      const format = await output(['git', 'config', '--get', 'gpg.format']);
      await output(['git', 'config', '--get', 'gpg.ssh.program']);
      if (format !== 'ssh') return null;
      const config = process.env.SSH_AUTH_SOCK
        ? ''
        : await output(['ssh', '-F', join(homedir(), '.ssh/config'), '-G', '*']);
      const agent = process.env.SSH_AUTH_SOCK ?? config.match(/^identityagent (.+)$/m)?.[1];
      const socket = agent?.startsWith('~/') ? join(homedir(), agent.slice(2)) : agent;
      return socket && isAbsolute(socket) ? socket : null;
    },
    undefined,
    'socket'
  )
  .endAsync('socket') as () => Promise<string | null>;
