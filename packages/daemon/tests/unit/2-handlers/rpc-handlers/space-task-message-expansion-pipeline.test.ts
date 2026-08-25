import { describe, test, expect } from 'bun:test';
import {
  runSpaceTaskMessageExpansion,
  type SpaceTaskMessageExpansionInput,
} from '../../../../src/lib/rpc-handlers/space-task-message-expansion-pipeline';

function baseInput(
  overrides: Partial<SpaceTaskMessageExpansionInput> = {}
): SpaceTaskMessageExpansionInput {
  return {
    taskId: 'task-1',
    messageId: 'msg-1',
    findSpaceTaskScope: () => ({ space_id: 'space-1' }),
    findSdkMessage: () => '{"type":"assistant"}',
    findGithubEvent: () => undefined,
    ...overrides,
  };
}

describe('spaceTaskMessage.get expansion pipeline', () => {
  test('rejects missing taskId or messageId before any lookup', () => {
    expect(runSpaceTaskMessageExpansion(baseInput({ taskId: '' }))).toEqual({
      status: 'invalidInput',
    });
    expect(runSpaceTaskMessageExpansion(baseInput({ messageId: '' }))).toEqual({
      status: 'invalidInput',
    });
  });

  test('rejects unknown task scopes as unauthorized', () => {
    expect(
      runSpaceTaskMessageExpansion(baseInput({ findSpaceTaskScope: () => undefined }))
    ).toEqual({ status: 'unauthorized' });
  });

  test('expands a stored sdk message', () => {
    expect(runSpaceTaskMessageExpansion(baseInput())).toEqual({
      status: 'expanded',
      sdkMessage: '{"type":"assistant"}',
    });
  });

  test('falls back to the synthetic GitHub user message', () => {
    const outcome = runSpaceTaskMessageExpansion(
      baseInput({
        findSdkMessage: () => undefined,
        findGithubEvent: () => ({
          id: 'gh-1',
          summary: 'PR review submitted',
          external_url: 'https://github.com/lsm/HyperNeo/pull/1',
        }),
      })
    );
    expect(outcome.status).toBe('expanded');
    if (outcome.status !== 'expanded') return;
    const parsed = JSON.parse(outcome.sdkMessage) as {
      type: string;
      uuid: string;
      message: { role: string; content: Array<{ type: string; text: string }> };
    };
    expect(parsed.type).toBe('user');
    expect(parsed.uuid).toBe('gh-1');
    expect(parsed.message.role).toBe('user');
    expect(parsed.message.content[0].text).toBe(
      '[GitHub] PR review submitted\nhttps://github.com/lsm/HyperNeo/pull/1'
    );
  });

  test('reports not found when neither source resolves', () => {
    expect(
      runSpaceTaskMessageExpansion(
        baseInput({ findSdkMessage: () => undefined, findGithubEvent: () => undefined })
      )
    ).toEqual({ status: 'notFound' });
  });

  test('gates messages above the expansion byte limit', () => {
    const oversized = 'x'.repeat(16 * 1024 * 1024 + 1);
    const outcome = runSpaceTaskMessageExpansion(
      baseInput({ messageId: 'big', findSdkMessage: () => oversized })
    );
    expect(outcome).toEqual({ status: 'tooLarge', messageId: 'big' });
  });

  test('admits a message exactly at the expansion byte limit', () => {
    const atLimit = 'x'.repeat(16 * 1024 * 1024);
    const outcome = runSpaceTaskMessageExpansion(baseInput({ findSdkMessage: () => atLimit }));
    expect(outcome.status).toBe('expanded');
  });
});
