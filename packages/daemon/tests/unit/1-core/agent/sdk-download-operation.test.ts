import { describe, expect, it } from 'bun:test';
import { createSdkDownloadOperation } from '../../../../src/lib/agent/sdk-download-operation.ts';

describe('daemon.retryClaudeDownload', () => {
  it('retries only the download once per invocation', async () => {
    let calls = 0;
    const operation = createSdkDownloadOperation(async () => {
      calls++;
      return calls === 1
        ? { status: 'failed', error: 'Cannot reach the npm registry.' }
        : { status: 'ready', path: '/fixture/claude' };
    });
    const caller = { source: 'rpc' as const };

    expect(await operation.execute({}, caller)).toEqual({
      accepted: false,
      reason: "Can't download Claude Code: Cannot reach the npm registry.",
    });
    expect(calls).toBe(1);
    expect(await operation.execute({}, caller)).toEqual({ accepted: true });
    expect(calls).toBe(2);
  });

  it('does not let an agent start a download', async () => {
    let calls = 0;
    const operation = createSdkDownloadOperation(async () => {
      calls++;
      return { status: 'ready' };
    });

    expect(await operation.execute({}, { source: 'mcp' })).toEqual({
      accepted: false,
      reason: 'Only a local user can retry the download.',
    });
    expect(calls).toBe(0);
  });
});
