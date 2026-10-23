import { describe, expect, it } from 'bun:test';
import { spawn } from 'node:child_process';
import { acpProcessGroupAlive } from '../../../../src/lib/acp/acp-process-tree';
import { AcpTransport, buildAcpProcessEnv } from '../../../../src/lib/acp/acp-transport';

describe('buildAcpProcessEnv', () => {
  it('removes provider-managed routing env from ACP subprocess env', () => {
    const env = buildAcpProcessEnv({
      ANTHROPIC_BASE_URL: undefined,
      ANTHROPIC_AUTH_TOKEN: undefined,
      ANTHROPIC_DEFAULT_SONNET_MODEL: undefined,
      KEEP_SESSION: 'session',
    });

    expect(env.KEEP_SESSION).toBe('session');
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBeUndefined();
  });

  it('replaces the inherited process env instead of merging when replaceEnv is set', () => {
    process.env.ACP_PROBE_TEST_SECRET = 'secret';
    try {
      const env = buildAcpProcessEnv({ PATH: '/safe/bin', HOME: '/safe/home' }, true);

      expect(env).toEqual({ PATH: '/safe/bin', HOME: '/safe/home' });
    } finally {
      delete process.env.ACP_PROBE_TEST_SECRET;
    }
  });
});

describe('AcpTransport replaceEnv spawn', () => {
  it('spawns a real subprocess that cannot see non-allowlisted process env vars', async () => {
    process.env.ACP_PROBE_TEST_SECRET = 'secret';
    let transport: AcpTransport | undefined;
    try {
      const exited = new Promise<number | null>((resolve) => {
        transport = new AcpTransport({
          command: 'sh',
          args: ['-c', '[ -z "$ACP_PROBE_TEST_SECRET" ]'],
          env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
          replaceEnv: true,
          onExit: (code) => resolve(code),
        });
      });

      expect(await exited).toBe(0);
    } finally {
      delete process.env.ACP_PROBE_TEST_SECRET;
      await transport?.close();
    }
  });
});

describe('acpProcessGroupAlive', () => {
  it('probes the direct pid on win32 instead of a POSIX process group', async () => {
    expect(acpProcessGroupAlive(process.pid, 'win32')).toBe(true);

    const child = spawn('true', [], { stdio: 'ignore' });
    await new Promise<void>((resolve) => child.on('exit', () => resolve()));
    expect(acpProcessGroupAlive(child.pid!, 'win32')).toBe(false);
  });
});

describe('AcpTransport.sendRequest onSubmitted', () => {
  it('rejects when the onSubmitted callback throws instead of pending until timeout (#3744105279)', async () => {
    const transport = new AcpTransport({
      command: 'sleep',
      args: ['30'],
      requestTimeoutMs: 60_000,
    } as never);
    try {
      await expect(
        transport.sendRequest('session/prompt', { sessionId: 's' } as never, {
          onSubmitted: () => {
            throw new Error('markMessageSubmitted exploded');
          },
        })
      ).rejects.toThrow('markMessageSubmitted exploded');
    } finally {
      await transport.close();
    }
  });

  const answeringAgent = () =>
    new AcpTransport({
      command: 'sh',
      args: [
        '-c',
        'read l; id=$(echo "$l" | sed -n \'s/.*"id":\\([0-9]*\\).*/\\1/p\'); echo "{\\"jsonrpc\\":\\"2.0\\",\\"id\\":$id,\\"result\\":{}}"; sleep 30',
      ],
      requestTimeoutMs: 60_000,
    } as never);
  const settleLater = () => new Promise((resolve) => setTimeout(resolve, 200));

  it('holds the response until an async onSubmitted settles', async () => {
    const transport = answeringAgent();
    let submitted = false;
    try {
      const response = await transport.sendRequest('session/prompt', { sessionId: 's' } as never, {
        onSubmitted: async () => {
          await settleLater();
          submitted = true;
        },
      });
      expect(submitted).toBe(true);
      expect(response).toMatchObject({ result: {} });
    } finally {
      await transport.close();
    }
  });

  it('rejects when an async onSubmitted fails after the response arrived', async () => {
    const transport = answeringAgent();
    try {
      await expect(
        transport.sendRequest('session/prompt', { sessionId: 's' } as never, {
          onSubmitted: async () => {
            await settleLater();
            throw new Error('revoked before submission');
          },
        })
      ).rejects.toThrow('revoked before submission');
    } finally {
      await transport.close();
    }
  });
});
