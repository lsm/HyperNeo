import { describe, expect, test, mock } from 'bun:test';
import { z } from 'zod';
import type { NeoAskEntry } from '@hyperneo/shared/types/neo-ask';
import {
  renderAskMarkdown,
  createAskMarkdownHandler,
} from '../../../../src/lib/neo/ask-markdown.ts';
import {
  createOperationRegistry,
  defineOperation,
} from '../../../../src/lib/operations/registry.ts';
import type { OperationCaller } from '../../../../src/lib/operations/registry.ts';
import type { UpgradeIdentity } from '../../../../src/lib/pairing/upgrade-auth.ts';

const entry = {
  ask: { title: 'Plan the visit', outcome: 'The itinerary is ready.' },
  state: 'waiting',
  todos: [
    { title: 'Book tickets', status: 'In progress', state: 'doing', doneWhen: 'Private evidence' },
    { title: 'Choose dates', status: 'Done', state: 'done' },
  ],
  questions: [
    { text: 'Which day?', state: 'open', kind: 'choice', options: ['Friday', 'Saturday'] },
    { text: 'Already answered', state: 'answered', kind: 'reply' },
    { text: 'Retired question', state: 'retired', kind: 'reply' },
  ],
} as NeoAskEntry;

describe('renderAskMarkdown', () => {
  test('renders public card content and only open questions', () => {
    expect(renderAskMarkdown(entry)).toBe(
      '# Plan the visit\n\nStatus: waiting\n\n## Todos\n\n' +
        '- Book tickets — In progress\n- Choose dates — Done\n\n' +
        '## Open questions\n\n### Which day?\n\n- Friday\n- Saturday\n\n' +
        '## Outcome\n\nThe itinerary is ready.\n'
    );
  });

  test('renders an empty card without inventing questions or an outcome', () => {
    expect(
      renderAskMarkdown({
        ...entry,
        ask: { ...entry.ask, outcome: null },
        todos: [],
        questions: [],
      })
    ).toBe('# Plan the visit\n\nStatus: waiting\n');
  });

  test('keeps inline fields as text and preserves the outcome Markdown', () => {
    const markdown = renderAskMarkdown({
      ...entry,
      ask: { ...entry.ask, title: '<script>\n# title', outcome: '**Ready**' },
      todos: [],
      questions: [
        {
          ...entry.questions[0],
          kind: 'yesno',
          text: 'Proceed?',
          options: null,
          yesLabel: 'Go',
          noLabel: 'Wait',
        },
      ],
    });
    expect(markdown).toContain('# \\<script\\> \\# title');
    expect(markdown).toContain('- Go\n- Wait');
    expect(markdown).toContain('## Outcome\n\n**Ready**');
  });
});

function handler(device: UpgradeIdentity | null = { deviceId: 'paired', kind: 'human' }) {
  const calls: { input: unknown; caller: OperationCaller }[] = [];
  const registry = createOperationRegistry([
    defineOperation({
      name: 'neo.ask.read',
      description: 'Read a card',
      inputSchema: z.object({ askId: z.string() }),
      resultSchema: z.unknown(),
      policy: { safetyClass: 'read', roles: ['neo'] },
      async execute(input, caller) {
        calls.push({ input, caller });
        if (input.askId === 'broken') throw new Error('Storage failed');
        return input.askId === 'missing'
          ? { ok: false, reason: 'not_found: no such ask.' }
          : { ok: true, entry };
      },
    }),
  ]);
  const authenticate = mock(async (_req: Request, _address: string | null) => device);
  return { registry, calls, authenticate };
}

describe('createAskMarkdownHandler', () => {
  test('uses the paired identity and the existing card operation', async () => {
    const { registry, calls, authenticate } = handler();
    const read = createAskMarkdownHandler(registry, authenticate);
    const req = new Request('http://localhost/ask/card%20one.md');
    const response = await read(req, '127.0.0.1');
    expect(response?.status).toBe(200);
    expect(response?.headers.get('content-type')).toBe('text/markdown; charset=utf-8');
    expect(response?.headers.get('cache-control')).toBe('no-store');
    expect(await response?.text()).toBe(renderAskMarkdown(entry));
    expect(authenticate).toHaveBeenCalledWith(req, '127.0.0.1');
    expect(calls).toEqual([
      {
        input: { askId: 'card one' },
        caller: {
          source: 'rpc',
          principal: 'local',
          device: { deviceId: 'paired', kind: 'human' },
        },
      },
    ]);
  });

  test.each(['card', 'missing'])('requires pairing before reading %s', async (id) => {
    const { registry, calls, authenticate } = handler(null);
    const read = createAskMarkdownHandler(registry, authenticate);
    const response = await read(new Request(`http://localhost/ask/${id}.md`), null);
    expect(response?.status).toBe(401);
    expect(await response?.text()).toContain('hyperneo read <link>');
    expect(response?.headers.get('cache-control')).toBe('no-store');
    expect(calls).toHaveLength(0);
  });

  test.each([
    ['missing', 404],
    ['broken', 500],
    ['%ZZ', 400],
  ])('returns an explicit error for %s', async (id, status) => {
    const { registry, authenticate } = handler();
    const read = createAskMarkdownHandler(registry, authenticate);
    const response = await read(new Request(`http://localhost/ask/${id}.md`), null);
    expect(response?.status).toBe(status);
    expect(response?.headers.get('cache-control')).toBe('no-store');
  });

  test('retains device operation restrictions', async () => {
    const { registry, calls, authenticate } = handler({ deviceId: 'peer', kind: 'daemon' });
    const read = createAskMarkdownHandler(registry, authenticate);
    expect((await read(new Request('http://localhost/ask/card.md'), null))?.status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  test.each(['/ws', '/ask/card', '/ask/a/b.md', '/assets/main.js', '/neo'])(
    'leaves %s to its existing handler',
    async (path) => {
      const { registry, authenticate } = handler();
      const read = createAskMarkdownHandler(registry, authenticate);
      expect(await read(new Request(`http://localhost${path}`), null)).toBeNull();
      expect(authenticate).not.toHaveBeenCalled();
    }
  );

  test('leaves other methods to their existing handlers', async () => {
    const { registry, authenticate } = handler();
    const read = createAskMarkdownHandler(registry, authenticate);
    expect(
      await read(new Request('http://localhost/ask/card.md', { method: 'POST' }), null)
    ).toBeNull();
    expect(authenticate).not.toHaveBeenCalled();
  });
});
