import { describe, expect, it } from 'vitest';
import type { SpaceViewMode } from '../signals';
import { deriveAppExpectedPath, type AppRoutingState } from '../app-routing';

const base: AppRoutingState = {
  sessionId: null,
  spaceId: 's1',
  spaceSessionId: null,
  spaceTaskId: null,
  spaceAgentHandle: null,
  spaceViewMode: 'overview',
  spaceConfigureTab: 'general',
  spaceTasksFilterTab: 'active',
  navSection: 'spaces',
};

describe('deriveAppExpectedPath', () => {
  it('derives the memories path (regression: used to fall through to Overview)', () => {
    expect(deriveAppExpectedPath({ ...base, spaceViewMode: 'memories' })).toBe(
      '/space/s1/memories'
    );
  });

  it('derives a distinct path for every space view mode', () => {
    const cases: Array<[SpaceViewMode, string]> = [
      ['overview', '/space/s1'],
      ['goals', '/space/s1/goals'],
      ['memories', '/space/s1/memories'],
      ['forge', '/space/s1/evolve'],
      ['tasks', '/space/s1/tasks'],
      ['agents', '/space/s1/agents'],
      ['configure', '/space/s1/configure'],
    ];
    for (const [mode, path] of cases) {
      expect(deriveAppExpectedPath({ ...base, spaceViewMode: mode })).toBe(path);
    }
  });

  it('honors a non-default tasks filter', () => {
    expect(
      deriveAppExpectedPath({ ...base, spaceViewMode: 'tasks', spaceTasksFilterTab: 'draft' })
    ).toBe('/space/s1/tasks/draft');
  });

  it('derives configure tab paths with general as the bare route', () => {
    expect(deriveAppExpectedPath({ ...base, spaceViewMode: 'configure' })).toBe(
      '/space/s1/configure'
    );
    expect(
      deriveAppExpectedPath({
        ...base,
        spaceViewMode: 'configure',
        spaceConfigureTab: 'agent-templates',
      })
    ).toBe('/space/s1/configure/agent-templates');
    expect(
      deriveAppExpectedPath({
        ...base,
        spaceViewMode: 'configure',
        spaceConfigureTab: 'workflow-templates',
      })
    ).toBe('/space/s1/configure/workflow-templates');
  });

  it('prioritizes a selected session/task over the space view mode', () => {
    expect(
      deriveAppExpectedPath({
        ...base,
        spaceViewMode: 'memories',
        spaceTaskId: 't-1',
      })
    ).toBe('/space/s1/task/t-1');
    expect(deriveAppExpectedPath({ ...base, spaceViewMode: 'memories', sessionId: 'sess-1' })).toBe(
      '/session/sess-1'
    );
  });

  it('falls back to nav-section roots when no space is selected', () => {
    expect(deriveAppExpectedPath({ ...base, spaceId: null, navSection: 'chats' })).toBe(
      '/sessions'
    );
    expect(deriveAppExpectedPath({ ...base, spaceId: null, navSection: 'settings' })).toBe(
      '/settings'
    );
    expect(deriveAppExpectedPath({ ...base, spaceId: null, navSection: 'spaces' })).toBe('/spaces');
  });
});
