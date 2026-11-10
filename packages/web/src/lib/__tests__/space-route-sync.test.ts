import { describe, expect, it } from 'vitest';
import type { SpaceViewMode } from '../space-signals';
import { deriveAppExpectedPath } from '../app-routing';
import { deriveSpaceRoute, type SpaceRouteState } from '../space-route-sync';

const base: SpaceRouteState = {
  spaceId: 's1',
  spaceSessionId: null,
  spaceTaskId: null,
  spaceAgentHandle: null,
  spaceViewMode: 'overview',
  spaceConfigureTab: 'general',
  spaceTasksFilterTab: 'active',
  navSection: 'spaces',
};

describe('deriveSpaceRoute', () => {
  it('derives the memories path (regression: used to fall through to Overview)', () => {
    expect(deriveSpaceRoute({ ...base, spaceViewMode: 'memories' })?.path).toBe(
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
      expect(deriveSpaceRoute({ ...base, spaceViewMode: mode })?.path).toBe(path);
    }
  });

  it('honors a non-default tasks filter', () => {
    expect(
      deriveSpaceRoute({ ...base, spaceViewMode: 'tasks', spaceTasksFilterTab: 'draft' })?.path
    ).toBe('/space/s1/tasks/draft');
  });

  it('derives configure tab paths with general as the bare route', () => {
    expect(deriveSpaceRoute({ ...base, spaceViewMode: 'configure' })?.path).toBe(
      '/space/s1/configure'
    );
    expect(
      deriveSpaceRoute({
        ...base,
        spaceViewMode: 'configure',
        spaceConfigureTab: 'agent-templates',
      })?.path
    ).toBe('/space/s1/configure/agent-templates');
    expect(
      deriveSpaceRoute({
        ...base,
        spaceViewMode: 'configure',
        spaceConfigureTab: 'workflow-templates',
      })?.path
    ).toBe('/space/s1/configure/workflow-templates');
  });

  it('prioritizes a selected task over the space view mode', () => {
    const route = deriveSpaceRoute({ ...base, spaceViewMode: 'memories', spaceTaskId: 't-1' });

    expect(route?.path).toBe('/space/s1/task/t-1');
  });

  it('claims the Spaces list and leaves other sections alone', () => {
    expect(deriveSpaceRoute({ ...base, spaceId: null })?.path).toBe('/spaces');
    expect(deriveSpaceRoute({ ...base, spaceId: null, navSection: 'chats' })).toBeNull();
  });
});

describe('deriveAppExpectedPath', () => {
  const app = { sessionId: null, extensionPath: null, navSection: 'chats' };

  it('prefers a selected session over an extension route', () => {
    expect(deriveAppExpectedPath({ ...app, sessionId: 'sess-1', extensionPath: '/space/s1' })).toBe(
      '/session/sess-1'
    );
  });

  it('uses the extension route when it has one', () => {
    expect(deriveAppExpectedPath({ ...app, extensionPath: '/space/s1' })).toBe('/space/s1');
  });

  it('falls back to section roots', () => {
    expect(deriveAppExpectedPath(app)).toBe('/sessions');
    expect(deriveAppExpectedPath({ ...app, navSection: 'settings' })).toBe('/settings');
    expect(deriveAppExpectedPath({ ...app, navSection: 'spaces' })).toBe('/sessions');
  });
});
