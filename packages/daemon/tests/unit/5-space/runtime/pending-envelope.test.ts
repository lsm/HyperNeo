import { describe, expect, test } from 'bun:test';
import { formatAgentMessage } from '../../../../src/lib/space/agent-message-envelope';
import {
  formatPendingRowForNodeAgent,
  formatPendingRowForSpaceAgent,
  hasAgentMessageEnvelope,
  isHumanPendingSource,
  pendingSourceLevel,
} from '../../../../src/lib/space/runtime/pending-envelope';

const TARGET_AGENT_NAME = 'coder';

function makeRow(
  overrides: Partial<{ sourceAgentName: string; message: string; taskId: string | null }> = {}
) {
  return {
    sourceAgentName: 'reviewer',
    message: 'queued note',
    taskId: null,
    ...overrides,
  };
}

describe('pendingSourceLevel', () => {
  test('maps task-agent, space-agent, and space-member sources to their levels', () => {
    expect(pendingSourceLevel('task-agent')).toBe('task-agent');
    expect(pendingSourceLevel('space-agent')).toBe('space-agent');
    expect(pendingSourceLevel('space-member')).toBe('session-agent');
  });

  test('maps every other source to the node-agent level', () => {
    expect(pendingSourceLevel('reviewer')).toBe('node-agent');
    expect(pendingSourceLevel('human')).toBe('node-agent');
  });
});

describe('isHumanPendingSource', () => {
  test('is true only for the human source', () => {
    expect(isHumanPendingSource('human')).toBe(true);
    expect(isHumanPendingSource('reviewer')).toBe(false);
    expect(isHumanPendingSource('task-agent')).toBe(false);
  });
});

describe('formatPendingRowForNodeAgent', () => {
  test('formats a peer node-agent source through formatAgentMessage', () => {
    const row = makeRow({ sourceAgentName: 'reviewer', message: 'peer note', taskId: 'task-7' });

    expect(formatPendingRowForNodeAgent(row, TARGET_AGENT_NAME)).toBe(
      formatAgentMessage({
        fromLevel: 'node-agent',
        fromAgentName: 'reviewer',
        toLevel: 'node-agent',
        body: 'peer note',
        taskId: 'task-7',
        nodeId: TARGET_AGENT_NAME,
      })
    );
  });

  test('maps the task-agent source level to the task-agent envelope', () => {
    const message = formatPendingRowForNodeAgent(
      makeRow({ sourceAgentName: 'task-agent', message: 'coord note' }),
      TARGET_AGENT_NAME
    );

    expect(message).toContain('─── Message from task-agent ───');
    expect(message).toContain('To reply, use: send_message with target "task-agent"');
  });

  test('maps the space-agent source level to the coordinator reply handle', () => {
    const message = formatPendingRowForNodeAgent(
      makeRow({ sourceAgentName: 'space-agent', message: 'coordinator note' }),
      TARGET_AGENT_NAME
    );

    expect(message).toContain('─── Message from space-agent ───');
    expect(message).toContain('To reply, use: send_message with target "@coordinator"');
  });

  test('maps a space-member source to the session-agent envelope', () => {
    const message = formatPendingRowForNodeAgent(
      makeRow({ sourceAgentName: 'space-member', message: 'member note' }),
      TARGET_AGENT_NAME
    );

    expect(message).toContain('─── Message from space-member ───');
    expect(message).toContain('To reply, use: send_message with target "@space-member"');
  });

  test('prefixes human messages instead of enveloping them', () => {
    expect(
      formatPendingRowForNodeAgent(
        makeRow({ sourceAgentName: 'human', message: 'plain words' }),
        TARGET_AGENT_NAME
      )
    ).toBe('[Message from human]: plain words');
  });

  test('passes already-enveloped rows through unchanged', () => {
    const enveloped = formatAgentMessage({
      fromLevel: 'node-agent',
      fromAgentName: 'reviewer',
      toLevel: 'node-agent',
      body: 'already enveloped',
    });

    expect(
      formatPendingRowForNodeAgent(
        makeRow({ sourceAgentName: 'reviewer', message: enveloped }),
        TARGET_AGENT_NAME
      )
    ).toBe(enveloped);
  });

  test('re-wraps an envelope whose sender does not match the row source', () => {
    const foreign = formatAgentMessage({
      fromLevel: 'node-agent',
      fromAgentName: 'someone-else',
      toLevel: 'node-agent',
      body: 'foreign envelope',
    });
    const message = formatPendingRowForNodeAgent(
      makeRow({ sourceAgentName: 'reviewer', message: foreign }),
      TARGET_AGENT_NAME
    );

    expect(message).toContain('─── Message from reviewer ───');
    expect(message).toContain(foreign);
  });
});

describe('formatPendingRowForSpaceAgent', () => {
  test('formats a plain node-agent row through formatAgentMessage at the space-agent level', () => {
    const row = makeRow({ sourceAgentName: 'reviewer', message: 'plain note', taskId: 'task-7' });

    expect(formatPendingRowForSpaceAgent(row)).toBe(
      formatAgentMessage({
        fromLevel: 'node-agent',
        fromAgentName: 'reviewer',
        toLevel: 'space-agent',
        body: 'plain note',
        taskId: 'task-7',
      })
    );
  });

  test('envelopes a human source instead of prefixing it', () => {
    const message = formatPendingRowForSpaceAgent(
      makeRow({ sourceAgentName: 'human', message: 'hi' })
    );

    expect(message).toContain('─── Message from human ───');
    expect(message).not.toContain('[Message from human]');
  });

  test('passes already-enveloped rows through unchanged', () => {
    const enveloped = formatAgentMessage({
      fromLevel: 'node-agent',
      fromAgentName: 'reviewer',
      toLevel: 'space-agent',
      body: 'already enveloped',
      taskId: 'task-7',
    });

    expect(
      formatPendingRowForSpaceAgent(
        makeRow({ sourceAgentName: 'reviewer', message: enveloped, taskId: 'task-7' })
      )
    ).toBe(enveloped);
  });
});

describe('hasAgentMessageEnvelope', () => {
  test('recognizes queued space-agent envelopes with canonical sender label', () => {
    const message = formatAgentMessage({
      fromLevel: 'space-agent',
      fromAgentName: 'space-agent',
      toLevel: 'node-agent',
      body: 'Queued message',
      taskId: 'task-123',
      nodeId: 'coder',
      replyTargetHandle: '@coordinator',
    });

    expect(hasAgentMessageEnvelope(message, 'space-agent', 'node-agent')).toBe(true);
  });

  test('recognizes legacy queued Space Agent envelopes during flush', () => {
    const message =
      '─── Message from Space Agent ───\n\n' +
      'Legacy queued message\n\n' +
      '─── Reply ───\n' +
      'To reply, use: send_message with target "space-agent"';

    expect(hasAgentMessageEnvelope(message, 'space-agent', 'node-agent')).toBe(true);
  });

  test('recognizes queued ad-hoc session envelopes from space-member', () => {
    const message = formatAgentMessage({
      fromLevel: 'session-agent',
      fromAgentName: 'space-member',
      toLevel: 'node-agent',
      body: 'Queued ad-hoc message',
      taskId: 'task-123',
      nodeId: 'coder',
      replyToSessionId: 'session-adhoc-42',
    });

    expect(hasAgentMessageEnvelope(message, 'space-member', 'node-agent')).toBe(true);
  });

  test('returns false when no envelope header is present', () => {
    expect(hasAgentMessageEnvelope('plain body', 'reviewer', 'node-agent')).toBe(false);
    expect(hasAgentMessageEnvelope('', 'reviewer', 'node-agent')).toBe(false);
  });

  test('returns false when the header sender does not match the row source', () => {
    const foreign = formatAgentMessage({
      fromLevel: 'node-agent',
      fromAgentName: 'someone-else',
      toLevel: 'node-agent',
      body: 'foreign envelope',
    });

    expect(hasAgentMessageEnvelope(foreign, 'reviewer', 'node-agent')).toBe(false);
  });
});
