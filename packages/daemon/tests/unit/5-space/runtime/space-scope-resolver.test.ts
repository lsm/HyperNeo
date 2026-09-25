import { describe, expect, test } from 'bun:test';
import type { Session, Space } from '@hyperneo/shared';
import {
  createSpaceScopeResolver,
  type SpaceScopeDependencies,
} from '../../../../src/lib/space/runtime/space-scope-resolver.ts';
import {
  makeSessionKindLongHorizonAgent,
  makeSessionKindPolicyContext,
  makeSessionOfKind,
  SESSION_KIND_AGENT_ID,
  SESSION_KIND_SPACE_ID,
  type SessionKind,
} from '../../helpers/session-kinds.ts';

const SPACE: Space = {
  id: SESSION_KIND_SPACE_ID,
  slug: 'scope-space',
  workspacePath: '/tmp/scope-space',
  name: 'Test Space',
  description: '',
  backgroundContext: 'The board is the record of truth.',
  instructions: 'Ship small slices.',
  sessionIds: [],
  status: 'active',
  createdAt: Date.now(),
  updatedAt: Date.now(),
};

function deps(
  kind: SessionKind,
  session: Session,
  space: Space | null = SPACE
): SpaceScopeDependencies {
  return {
    ...makeSessionKindPolicyContext(kind),
    getSession: (id) => (id === session.id ? session : null),
    getSpace: (id) => (space && id === space.id ? space : null),
  };
}

describe('createSpaceScopeResolver', () => {
  test('names the Space, the id and the agent display name for a Space agent card session', () => {
    const session = makeSessionOfKind('agent_card');

    const scope = createSpaceScopeResolver(deps('agent_card', session))(session.id);

    expect(scope?.facet).toBe('space');
    expect(scope?.briefing).toContain(`the Space "Test Space" (id: ${SESSION_KIND_SPACE_ID})`);
    expect(scope?.briefing).toContain('Your role in it is the Space agent "Card Agent".');
    expect(scope?.briefing).toContain('### Space Standing Instructions');
    expect(scope?.briefing).toContain('Ship small slices.');
  });

  test('falls back to the standing-agent wording when the agent record carries no display name', () => {
    const session = makeSessionOfKind('agent_card');

    const scope = createSpaceScopeResolver({
      ...deps('agent_card', session),
      longHorizonAgentRepo: { getById: () => makeSessionKindLongHorizonAgent({ displayName: '' }) },
    })(session.id);

    expect(scope?.briefing).toContain('Your role in it is one of its standing Space agents.');
  });

  test('contributes nothing for a Space session no agent owns', () => {
    const session = makeSessionOfKind('unowned_space');

    expect(createSpaceScopeResolver(deps('unowned_space', session))(session.id)).toBeUndefined();
  });

  test('names the workflow-node role for a workflow worker', () => {
    const session = makeSessionOfKind('workflow_worker');

    const scope = createSpaceScopeResolver(deps('workflow_worker', session))(session.id);

    expect(scope?.briefing).toContain(
      'Your role in it is a worker session running one node of a Space workflow for an assigned task.'
    );
  });

  test('names the direct-task role for a worker whose attempt no longer resolves', () => {
    const session = makeSessionOfKind('direct_task_worker');

    const scope = createSpaceScopeResolver(deps('direct_task_worker', session))(session.id);

    expect(scope?.briefing).toContain(
      'Your role in it is a worker session running one assigned Space task directly, outside any workflow.'
    );
    expect(scope?.briefing).toContain(`the Space "Test Space" (id: ${SESSION_KIND_SPACE_ID})`);
  });

  test("includes the bound agent's own standing instructions under their own heading", () => {
    const session = makeSessionOfKind('agent_card');

    const scope = createSpaceScopeResolver({
      ...deps('agent_card', session),
      longHorizonAgentRepo: {
        getById: () =>
          makeSessionKindLongHorizonAgent({ instructions: 'Triage the board and stay honest.' }),
      },
    })(session.id);

    expect(scope?.briefing).toContain('### Agent Standing Instructions');
    expect(scope?.briefing).toContain('Triage the board and stay honest.');
    expect(scope?.briefing?.indexOf('### Space Standing Instructions')).toBeLessThan(
      scope?.briefing?.indexOf('### Agent Standing Instructions') ?? -1
    );
  });

  test('reaches a workflow worker bound to an agent, not only the agent card session', () => {
    const session = makeSessionOfKind('workflow_worker', {
      metadata: {
        messageCount: 0,
        totalTokens: 0,
        inputTokens: 0,
        outputTokens: 0,
        totalCost: 0,
        toolCallCount: 0,
        promptProvenance: {
          source: 'test',
          hash: 'hash',
          agentId: SESSION_KIND_AGENT_ID,
          agentName: 'Coder',
        },
      },
    } as unknown as Partial<Session>);

    const scope = createSpaceScopeResolver({
      ...deps('workflow_worker', session),
      longHorizonAgentRepo: {
        getById: () => makeSessionKindLongHorizonAgent({ instructions: 'Open exactly one PR.' }),
      },
    })(session.id);

    expect(scope?.briefing).toContain('### Agent Standing Instructions');
    expect(scope?.briefing).toContain('Open exactly one PR.');
    expect(scope?.briefing).not.toContain('Your role in it is the Space agent');
  });

  test('omits the agent standing-instructions heading when the bound agent has none', () => {
    const session = makeSessionOfKind('agent_card');

    const scope = createSpaceScopeResolver({
      ...deps('agent_card', session),
      longHorizonAgentRepo: {
        getById: () => makeSessionKindLongHorizonAgent({ instructions: '' }),
      },
    })(session.id);

    expect(scope?.briefing).not.toContain('### Agent Standing Instructions');
  });

  test('omits the agent standing-instructions heading for a session with no bound agent', () => {
    const session = makeSessionOfKind('ad_hoc_member');

    const scope = createSpaceScopeResolver(deps('ad_hoc_member', session))(session.id);

    expect(scope?.briefing).not.toContain('### Agent Standing Instructions');
  });

  test('drops the standing-instructions section when the Space has none', () => {
    const session = makeSessionOfKind('agent_card');

    const scope = createSpaceScopeResolver(
      deps('agent_card', session, { ...SPACE, instructions: '   ' })
    )(session.id);

    expect(scope?.briefing).toContain('Card Agent');
    expect(scope?.briefing).not.toContain('### Space Standing Instructions');
  });

  test('contributes nothing for a session outside any Space, an unknown session, or a missing Space', () => {
    const outsider = makeSessionOfKind('non_space');
    const member = makeSessionOfKind('agent_card');

    expect(createSpaceScopeResolver(deps('non_space', outsider))(outsider.id)).toBeUndefined();
    expect(createSpaceScopeResolver(deps('agent_card', member))('absent')).toBeUndefined();
    expect(createSpaceScopeResolver(deps('agent_card', member, null))(member.id)).toBeUndefined();
  });
});
