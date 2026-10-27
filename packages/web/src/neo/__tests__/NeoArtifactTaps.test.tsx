import type { NeoAskEntry, NeoQuestionEntry, NeoTodoEntry } from '@hyperneo/shared/types/neo-ask';
import type { NeoPublication } from '@hyperneo/shared/types/neo-publication';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ArtifactPreviewPanel } from '../../components/artifacts/ArtifactPreviewPanel.tsx';
import { closeArtifactPreview } from '../../lib/artifact-preview-store.ts';
import { connectionState } from '../../lib/state.ts';
import { artifactPreviewStack } from '../../lib/artifact-preview-store.ts';
import { NeoAskTodos } from '../NeoAskTodos.tsx';
import { NeoPublicConversation } from '../NeoPublicConversation.tsx';
import { projectNeoPublicConversation } from '../public-conversation.ts';

const conversationId = '10000000-0000-4000-8000-000000000001';
const request = vi.hoisted(() => vi.fn());
vi.mock('../../lib/connection-manager.ts', () => ({
  connectionManager: { getHub: async () => ({ request }) },
}));
const root = `neo:${conversationId}`;
const origin = { sessionId: root, messageId: 'original' };
const report = {
  daemonId: 'd',
  artifactId: 'a-report',
  title: 'Layout report',
  kind: 'html' as const,
  byteLength: 86_016,
};
const publication = (fields: Partial<NeoPublication> = {}): NeoPublication => ({
  conversationId,
  publicationId: '20000000-0000-4000-8000-000000000001',
  askOrigin: origin,
  producerInput: { sessionId: root, messageId: 'turn' },
  shortText: 'The design is in `docs/design/layout.md`; see https://github.com/acme/demo/pull/7.',
  fullText: 'The design is in `docs/design/layout.md`; see https://github.com/acme/demo/pull/7.',
  links: [],
  sequence: 1,
  createdAt: '2026-10-21T12:00:01Z',
  ...fields,
});
const conversation = (item: NeoPublication) =>
  projectNeoPublicConversation(
    root,
    { conversationId, status: 'ready', items: [], nextAfter: 0, hasMore: false, hasEarlier: false },
    {
      conversationId,
      status: 'ready',
      items: [item],
      nextAfter: 1,
      hasMore: false,
      hasEarlier: false,
    }
  );

beforeEach(() => {
  artifactPreviewStack.value = [];
  sessionStorage.clear();
});
afterEach(cleanup);

describe('Neo artifact taps', () => {
  describe('publication paths without registered artifacts', () => {
    beforeEach(() => {
      closeArtifactPreview();
      connectionState.value = 'connected';
      vi.spyOn(window, 'matchMedia').mockImplementation((media) => ({
        matches: true,
        media,
        onchange: null,
        addListener() {},
        removeListener() {},
        addEventListener() {},
        removeEventListener() {},
        dispatchEvent: () => true,
      }));
      vi.spyOn(history, 'back').mockImplementation(() => {});
    });
    afterEach(() => {
      closeArtifactPreview();
      vi.restoreAllMocks();
      request.mockReset();
    });

    it.each([
      ['inline code', '~/HyperNeo/引用配色/quote-colour-options.html', true],
      ['plain text', '/Users/synthetic/HyperNeo/引用配色/quote-colour-options.html', false],
    ])('keeps an unavailable %s HTML path in the tabbed panel', async (_kind, path, code) => {
      let refuse!: (value: unknown) => void;
      request.mockImplementation(
        () =>
          new Promise((resolve) => {
            refuse = resolve;
          })
      );
      render(
        <>
          <NeoPublicConversation
            conversation={conversation(
              publication({
                shortText: code ? `Read \`${path}\`` : 'Read the full report.',
                fullText: code ? `Read \`${path}\`` : `Read ${path}`,
              })
            )}
          />
          <ArtifactPreviewPanel fileTabs work={{ id: 'work', showTab: true, count: 1 }} />
        </>
      );
      if (!code) fireEvent.click(await screen.findByRole('button', { name: /more/i }));
      fireEvent.click(await screen.findByText(path));
      await waitFor(() => expect(refuse).toBeTypeOf('function'));
      expect(screen.getByRole('tab', { name: 'Your work · 1' })).toBeTruthy();
      const tab = screen.getByRole('tab', { name: path });
      expect(tab.getAttribute('aria-selected')).toBe('true');
      expect(screen.getByRole('status').textContent).toBe('Loading preview…');
      refuse({ accepted: false, reason: 'unavailable' });
      await screen.findByText('This file is no longer available to you.');
      expect(screen.getByRole('tab', { name: path })).toBe(tab);
      expect(screen.getByRole('tabpanel').id).toBe(tab.getAttribute('aria-controls'));
      expect(screen.queryByRole('button', { name: 'Back', exact: true })).toBeNull();
      expect(request.mock.calls[0][1].input.reference).toBe(path);
      expect(request.mock.calls[0][1].input.sourceMessageOrCard).toMatchObject({
        kind: 'publication',
        id: publication().publicationId,
      });
      fireEvent.click(screen.getByRole('tab', { name: 'Your work · 1' }));
      await waitFor(() =>
        expect(screen.queryByText('This file is no longer available to you.')).toBeNull()
      );
    });
  });
  it('opens a registered document from a question card in the existing preview', () => {
    const entry: NeoAskEntry = {
      ask: {
        id: 'ask',
        projectId: null,
        repo: null,
        parentId: null,
        sessionId: 'neo',
        originMessageId: null,
        title: 'Review',
        request: 'Review the report',
        status: 'open',
        outcome: null,
        createdAt: 1,
        updatedAt: 1,
        settledAt: null,
      },
      state: 'doing',
      todos: [],
      doneCount: 0,
      questions: [
        {
          id: 'question',
          askId: 'ask',
          text: 'Please review the report.',
          kind: 'reply',
          options: null,
          multiple: false,
          noLabel: null,
          yesLabel: null,
          startTodos: null,
          state: 'open',
          answer: null,
          answeredBy: null,
          answeredAt: null,
          retiredReason: null,
          replacedBy: null,
          createdAt: 1,
          artifacts: [report],
        } as NeoQuestionEntry,
      ],
    };
    render(<NeoAskTodos entry={entry} onAnswer={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open preview: Layout report' }));
    expect(artifactPreviewStack.value).toEqual([{ kind: 'artifact', artifactId: 'a-report' }]);
  });

  it('shows a short card for a published artifact and opens it in the app', async () => {
    render(
      <NeoPublicConversation conversation={conversation(publication({ artifacts: [report] }))} />
    );
    const card = await screen.findByRole('button', { name: 'Open preview: Layout report' });
    expect(card.textContent).toBe('Layout report · HTML · 84 KB · Open preview');
    fireEvent.click(card);
    expect(artifactPreviewStack.value).toEqual([{ kind: 'artifact', artifactId: 'a-report' }]);
  });

  it('opens a path or PR link in a publication against that exact publication', async () => {
    render(
      <NeoPublicConversation conversation={conversation(publication({ revisionId: 'rev-2' }))} />
    );
    await waitFor(() => expect(screen.getByText('docs/design/layout.md')).toBeTruthy());
    fireEvent.click(screen.getByText('docs/design/layout.md'));
    expect(artifactPreviewStack.value).toEqual([
      {
        kind: 'reference',
        source: { kind: 'publication', id: publication().publicationId, revisionId: 'rev-2' },
        reference: 'docs/design/layout.md',
      },
    ]);
    fireEvent.click(screen.getByText('https://github.com/acme/demo/pull/7'));
    expect(artifactPreviewStack.value[0]).toMatchObject({
      reference: 'https://github.com/acme/demo/pull/7',
    });
  });

  it('shows evidence cards on a todo', () => {
    const todo = {
      id: 't1',
      askId: 'ask',
      position: 0,
      priority: 'normal' as const,
      dependsOn: null,
      title: 'Write the layout report',
      doneWhen: 'Report attached',
      check: null,
      instruction: '',
      named: null,
      repo: null,
      state: 'done',
      reason: null,
      blockedReason: null,
      nextAction: null,
      blockedBy: null,
      replacedBy: null,
      addedAfterStart: false,
      report: null,
      evidence: 'Attached',
      createdAt: 1,
      updatedAt: 1,
      startedAt: 1,
      finishedAt: 2,
      status: 'Done',
      link: null,
      remoteLink: null,
      artifacts: [report],
    } as NeoTodoEntry;
    const entry: NeoAskEntry = {
      ask: {
        id: 'ask',
        projectId: null,
        repo: null,
        parentId: null,
        sessionId: 'neo',
        originMessageId: null,
        title: 'Layout',
        request: 'x',
        status: 'open',
        outcome: null,
        createdAt: 1,
        updatedAt: 1,
        settledAt: null,
      },
      state: 'doing',
      todos: [todo, { ...todo, id: 't2', state: 'doing', artifacts: undefined }],
      doneCount: 1,
      questions: [],
    };
    render(<NeoAskTodos entry={entry} onAnswer={() => {}} />);
    const row = document.querySelector('[data-ask-todo="t1"]') as HTMLElement;
    expect(within(row).queryByRole('button', { name: 'Open preview: Layout report' })).toBeNull();
    fireEvent.click(
      within(row).getByRole('button', { name: 'Show details: Write the layout report' })
    );
    fireEvent.click(within(row).getByRole('button', { name: 'Open preview: Layout report' }));
    expect(artifactPreviewStack.value).toEqual([{ kind: 'artifact', artifactId: 'a-report' }]);
  });
});
