import { describe, expect, test } from 'bun:test';
import {
  buildNeoRoutePrompt,
  readNeoRouteAnswer,
} from '../../../../src/lib/neo/route-classifier.ts';
import { chooseNeoRoute, type NeoHolder } from '../../../../src/lib/neo/router.ts';

const drivers: NeoHolder = {
  concernId: 'drivers',
  sessionId: 'neo:holder:drivers',
  title: 'Neo driver epic',
  summary: 'Work drivers for Codex and Claude',
};
const youtube: NeoHolder = {
  concernId: 'youtube',
  sessionId: 'neo:holder:yt',
  title: 'YouTube pipeline',
  summary: '',
};

describe('buildNeoRoutePrompt', () => {
  test('lists each candidate topic and the main fallback', () => {
    const prompt = buildNeoRoutePrompt('restart the daemon?', [drivers, youtube]);
    expect(prompt).toContain('restart the daemon?');
    expect(prompt).toContain('- id: drivers\n  title: Neo driver epic');
    expect(prompt).toContain('summary: (none)');
    expect(prompt).toContain('main if it starts a new continuing topic');
  });
});

describe('readNeoRouteAnswer', () => {
  test('accepts only a listed id', () => {
    expect(readNeoRouteAnswer(' `drivers` ', [drivers, youtube])).toBe(drivers);
    expect(readNeoRouteAnswer('main', [drivers, youtube])).toBeNull();
    expect(readNeoRouteAnswer('garden', [drivers])).toBeNull();
  });
});

describe('chooseNeoRoute with a classifier', () => {
  const close = { drivers: [1, 0, 0], youtube: [0.98, 0.2, 0] } as Record<string, number[]>;
  const deps = (
    classify: (text: string, c: readonly NeoHolder[]) => Promise<NeoHolder | null>
  ) => ({
    holders: () => [drivers, youtube],
    latestRoute: () => null,
    recentAsks: () => [],
    embed: async (text: string) =>
      Float32Array.from(
        text.startsWith('Neo driver')
          ? close.drivers
          : text.startsWith('YouTube')
            ? close.youtube
            : [0.9, 0.1, 0]
      ),
    classify,
    now: () => 0,
  });

  test('asks the classifier when two holders are too close to call', async () => {
    const seen: string[][] = [];
    const route = await chooseNeoRoute(
      'which one?',
      deps(async (_text, candidates) => {
        seen.push(candidates.map((holder) => holder.concernId));
        return youtube;
      })
    );
    expect(seen).toEqual([['youtube', 'drivers']]);
    expect(route).toMatchObject({ concernId: 'youtube', signal: 'classifier' });
  });

  test('stays with main Neo when the classifier is unsure', async () => {
    expect(
      await chooseNeoRoute(
        'which one?',
        deps(async () => null)
      )
    ).toBeNull();
  });
});
