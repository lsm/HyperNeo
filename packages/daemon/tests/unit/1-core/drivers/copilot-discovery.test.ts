import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AcpClient } from '../../../../src/lib/acp/acp-client';
import {
  ACP_AGENTS,
  copilotSessionFolder,
  createAcpAgentAdapter,
  listAcpAgentSessions,
  readAcpSessionPages,
} from '../../../../src/lib/drivers/acp-agent-adapter';
import { createWorkVerbOperations } from '../../../../src/lib/drivers/work-operations';
import { invokeOperation } from '../../../../src/lib/operations/invoke';
import { createOperationRegistry } from '../../../../src/lib/operations/registry';
import {
  copilotFixture,
  copilotFolder,
  copilotSession,
  prepareCopilotFixture,
} from '../../../helpers/copilot-fixture';

const runs: string[] = [];
afterEach(() => {
  for (const run of runs.splice(0)) rmSync(run, { recursive: true, force: true });
});
function fixture() {
  const run = mkdtempSync(join(tmpdir(), 'copilot-pin-'));
  runs.push(run);
  return prepareCopilotFixture(run);
}
function clientFor(home: string) {
  return new AcpClient({
    command: 'bun',
    args: [copilotFixture],
    cwd: home,
    env: { HOME: home, PATH: process.env.PATH ?? '' },
    replaceEnv: true,
    requestTimeoutMs: 2000,
  });
}

describe('Copilot discovery boundary', () => {
  test('pages over ACP and recovers cwd without claiming worker receipt support', async () => {
    const { home } = fixture();
    const client = clientFor(home);
    try {
      const sessions = await readAcpSessionPages(
        client,
        { sessionFolder: (id) => copilotSessionFolder(id, join(home, '.copilot/session-state')) },
        home,
        0
      );
      expect(sessions.map((s) => [s.sessionId, s.cwd, s.title])).toEqual([
        [copilotSession, copilotFolder, 'Synthetic sum task'],
        ['22222222-2222-4222-8222-222222222222', '/synthetic/other-project', 'Other task'],
      ]);
      const adapter = createAcpAgentAdapter({
        agent: ACP_AGENTS[0],
        machine: 'fixture',
        now: Date.now,
        listSessions: async () => sessions,
        ownSessions: () => new Set([copilotSession]),
        projectFolder: (f) => f,
      });
      const groups = await adapter.find({ includeClosed: true, limit: 20 });
      expect(groups.flatMap((g) => g.work.map((w) => w.ref.id))).toEqual([
        '22222222-2222-4222-8222-222222222222',
      ]);
      expect(await adapter.find({ folder: copilotFolder, includeClosed: true, limit: 20 })).toEqual(
        []
      );
      const remote = {
        list: () => [],
        invoke: async () => {
          throw new Error('no remote');
        },
      };
      const registry = createOperationRegistry(
        createWorkVerbOperations({ adapters: () => [adapter], daemonName: 'fixture', remote })
      );
      for (const [name, input] of [
        [
          'work.send',
          { ref: { adapter: 'copilot-cli', id: copilotSession }, message: 'follow-up' },
        ],
        [
          'work.status',
          {
            ref: { adapter: 'copilot-cli', id: copilotSession },
            receipt: { executionId: copilotSession, inputId: 'unconsumed-input' },
          },
        ],
        ['work.stop', { ref: { adapter: 'copilot-cli', id: copilotSession } }],
      ] as const) {
        expect(await invokeOperation(registry, name, input, { source: 'rpc' })).toMatchObject({
          kind: 'completed',
          value: { ok: false, reason: 'unsupported' },
        });
      }
    } finally {
      await client.close();
    }
    const calls = readFileSync(join(home, 'evidence/calls.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line).method);
    expect(calls).toEqual(['initialize', 'session/list', 'session/list']);
  });

  test('streams only the loaded session and reports cancellation, preserving history', async () => {
    const { home } = fixture();
    const client = clientFor(home);
    try {
      await client.initialize();
      await client.loadSession(copilotSession, copilotFolder);
      const text: string[] = [];
      let accepted = 0;
      for await (const event of client.sendPrompt([{ type: 'text', text: 'wait' }], {
        onAccepted: () => {
          accepted++;
        },
      })) {
        if (
          event.update.sessionUpdate === 'agent_message_chunk' &&
          event.update.content.type === 'text'
        )
          text.push(event.update.content.text);
        client.cancel();
      }
      expect(text).toEqual(['Synthetic working']);
      expect(accepted).toBe(1);
      expect(client.getLastPromptStopReason()).toBe('cancelled');
      expect(await copilotSessionFolder(copilotSession, join(home, '.copilot/session-state'))).toBe(
        copilotFolder
      );
    } finally {
      await client.close();
    }
  });

  test('refuses incompatible discovery protocol instead of fabricating sessions', async () => {
    const { home } = fixture();
    await expect(
      listAcpAgentSessions('bun', { args: [copilotFixture, '--bad-version'] }, home, 3000)
    ).rejects.toThrow('Unsupported ACP protocol version');
  });
});
