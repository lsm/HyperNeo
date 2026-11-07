import type { NeoAskEntry, NeoQuestionEntry, NeoTodoEntry } from '@hyperneo/shared/types/neo-ask';
import type { NeoPublication } from '@hyperneo/shared/types/neo-publication';
import * as fileReferences from '@hyperneo/shared/types/artifact-reference';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ArtifactPreviewPanel } from '../../components/artifacts/ArtifactPreviewPanel.tsx';
import { closeArtifactPreview } from '../../lib/artifact-preview-store.ts';
import { connectionState } from '../../lib/state.ts';
import { artifactPreviewStack } from '../../lib/artifact-preview-store.ts';
import { NeoAskTodos } from '../NeoAskTodos.tsx';
import { NeoPublicConversation } from '../NeoPublicConversation.tsx';
import { projectNeoPublicConversation } from '../public-conversation.ts';
import { testAskEntry, testTodo } from './neo-test-views.ts';

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
  shortText:
    'The design is in `/synthetic/docs/design/layout.md`; see https://github.com/acme/demo/pull/7.',
  fullText:
    'The design is in `/synthetic/docs/design/layout.md`; see https://github.com/acme/demo/pull/7.',
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
afterEach(() => vi.restoreAllMocks());

describe('Neo artifact taps', () => {
  describe('current file cards', () => {
    beforeEach(() => {
      closeArtifactPreview();
      request.mockReset();
      connectionState.value = 'connected';
    });
    afterEach(closeArtifactPreview);

    it('derives one card per literal file reference without rewriting a publication', async () => {
      const body =
        'Read `/synthetic/report.md` twice: `/synthetic/report.md`.\n\n```sh\nignored.md\n```\n\nhttps://github.com/acme/demo/pull/7';
      const item = publication({
        shortText: undefined,
        fullText: body,
        revisionId: 'visible-revision',
        verbatim: true,
      });
      render(<NeoPublicConversation conversation={conversation(item)} />);
      const card = await screen.findByRole('button', { name: 'Open current file: report.md' });
      expect(screen.getAllByRole('button', { name: /^Open current file:/ })).toHaveLength(1);
      fireEvent.click(card);
      expect(artifactPreviewStack.value).toEqual([
        {
          kind: 'reference',
          source: { kind: 'publication', id: item.publicationId, revisionId: 'visible-revision' },
          reference: '/synthetic/report.md',
        },
      ]);
      expect(item.fullText).toBe(body);
      expect(request).not.toHaveBeenCalled();
    });

    it('deduplicates paths in expanded todo details and retains the todo source', async () => {
      const todo = testTodo('file-todo', {
        title: 'File result',
        instruction: 'Read `/synthetic/report.md`.',
        report: 'Updated `/synthetic/report.md`.',
      });
      render(
        <NeoAskTodos entry={testAskEntry('ask', 'Work', { todos: [todo] })} onAnswer={() => {}} />
      );
      fireEvent.click(screen.getByText('File result'));
      const card = await screen.findByRole('button', { name: 'Open current file: report.md' });
      expect(screen.getAllByRole('button', { name: /^Open current file:/ })).toHaveLength(1);
      fireEvent.click(card);
      expect(artifactPreviewStack.value.at(-1)).toEqual({
        kind: 'reference',
        source: { kind: 'todo', id: todo.id },
        reference: '/synthetic/report.md',
      });
    });

    it('derives question cards from public body/document text, not worker metadata', async () => {
      const question: NeoQuestionEntry = {
        id: 'file-question',
        askId: 'ask',
        text: `Read \`/synthetic/report.md\`, [the PR](https://github.com/acme/demo/pull/7) and [the blob](https://github.com/acme/demo/blob/${'a'.repeat(40)}/file.md).`,
        document: 'Full report: `/synthetic/report.md`',
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
        sourceSession: {
          id: 'worker',
          adapter: 'hyperneo',
          name: 'metadata-only.md',
          label: 'metadata-only.md',
          provider: 'synthetic',
          link: null,
        },
      };
      const parse = vi.spyOn(fileReferences, 'previewLinkedReferenceCandidates');
      const entry = testAskEntry('ask', 'Work', { questions: [question] });
      const { rerender } = render(<NeoAskTodos entry={entry} onAnswer={() => {}} />);
      const inline = await screen.findByRole('link', {
        name: 'Open preview: /synthetic/report.md',
      });
      const github = screen.getByRole('link', { name: 'the PR' });
      const parseCount = parse.mock.calls.filter(([text]) => text === question.text).length;
      expect(parseCount).toBeGreaterThan(0);
      rerender(<NeoAskTodos entry={entry} onAnswer={() => {}} />);
      expect(parse.mock.calls.filter(([text]) => text === question.text)).toHaveLength(parseCount);
      expect(github.getAttribute('href')).toBe('https://github.com/acme/demo/pull/7');
      expect(github.hasAttribute('data-preview-reference')).toBe(false);
      expect(
        screen.getByRole('link', { name: 'the blob' }).hasAttribute('data-preview-reference')
      ).toBe(false);
      fireEvent.click(inline);
      expect(artifactPreviewStack.value.at(-1)).toEqual({
        kind: 'reference',
        source: { kind: 'question', id: question.id },
        reference: '/synthetic/report.md',
      });
      const card = await screen.findByRole('button', { name: 'Open current file: report.md' });
      expect(screen.getAllByRole('button', { name: /^Open current file:/ })).toHaveLength(1);
      fireEvent.click(card);
      expect(artifactPreviewStack.value.at(-1)).toEqual({
        kind: 'reference',
        source: { kind: 'question', id: question.id },
        reference: '/synthetic/report.md',
      });
      const updated = { ...question, text: 'Read `/synthetic/updated.md`.' };
      rerender(
        <NeoAskTodos
          entry={testAskEntry('ask', 'Work', { questions: [updated] })}
          onAnswer={() => {}}
        />
      );
      expect(
        await screen.findByRole('link', { name: 'Open preview: /synthetic/updated.md' })
      ).toBeTruthy();
      expect(parse.mock.calls.some(([text]) => text === updated.text)).toBe(true);
      parse.mockRestore();
    });

    it('includes visible todo title/status and adds detail/action paths only when expanded', async () => {
      const todo = testTodo('status-file-todo', {
        title: 'Read `/synthetic/title.md`',
        status: 'Blocked: read `/synthetic/status.md`',
        blockedReason: 'read `/synthetic/status.md`',
        state: 'blocked',
        instruction: 'Read `/synthetic/title.md` and `/synthetic/detail.md`',
        nextAction: 'Read `/synthetic/next.md`',
      });
      render(
        <NeoAskTodos entry={testAskEntry('ask', 'Work', { todos: [todo] })} onAnswer={() => {}} />
      );
      expect(screen.getAllByRole('button', { name: /^Open current file:/ })).toHaveLength(2);
      expect(screen.queryByRole('button', { name: 'Open current file: detail.md' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Open current file: next.md' })).toBeNull();
      fireEvent.click(screen.getByText(todo.title));
      expect(screen.getAllByRole('button', { name: /^Open current file:/ })).toHaveLength(4);
      expect(screen.getAllByRole('button', { name: 'Open current file: title.md' })).toHaveLength(
        1
      );
    });

    it('keeps same-name files distinct and preserves an encoded file URL exactly', async () => {
      const body =
        'Read `/synthetic/first/report.md`, `/synthetic/second/report.md` and [the report](file:///synthetic/My%20report.md).';
      render(
        <NeoPublicConversation
          conversation={conversation(publication({ shortText: body, fullText: body }))}
        />
      );
      const named = await screen.findAllByRole('button', { name: 'Open current file: report.md' });
      expect(named.map((card) => card.getAttribute('title'))).toEqual([
        '/synthetic/first/report.md',
        '/synthetic/second/report.md',
      ]);
      fireEvent.click(named[1]);
      expect(artifactPreviewStack.value.at(-1)?.kind).toBe('reference');
      expect(artifactPreviewStack.value.at(-1)).toMatchObject({
        reference: '/synthetic/second/report.md',
      });
      fireEvent.click(screen.getByRole('button', { name: 'Open current file: My report.md' }));
      expect(artifactPreviewStack.value.at(-1)).toMatchObject({
        reference: 'file:///synthetic/My%20report.md',
      });
    });

    it('lets unsupported file cards reach the reader and shows its accurate refusal', async () => {
      const body = 'Open `/synthetic/unknown.bin`.';
      request.mockResolvedValue({ accepted: false, reason: 'unsupported_type' });
      render(
        <>
          <NeoPublicConversation
            conversation={conversation(publication({ shortText: body, fullText: body }))}
          />
          <ArtifactPreviewPanel />
        </>
      );
      fireEvent.click(
        await screen.findByRole('button', { name: 'Open current file: unknown.bin' })
      );
      await screen.findByText('This format has no preview yet.');
      expect(request.mock.calls[0][1]).toMatchObject({
        name: 'file.reference.read',
        input: {
          reference: '/synthetic/unknown.bin',
          sourceMessageOrCard: { kind: 'publication', id: publication().publicationId },
        },
      });
    });
  });
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
          <ArtifactPreviewPanel fileTabs work={{ id: 'work', count: 1 }} />
        </>
      );
      if (!code) fireEvent.click(await screen.findByRole('button', { name: /more/i }));
      fireEvent.click(await screen.findByText(path));
      await waitFor(() => expect(refuse).toBeTypeOf('function'));
      expect(screen.getByRole('tab', { name: 'Your work · 1' })).toBeTruthy();
      const tab = screen.getByRole('tab', { name: path.split('/').at(-1) });
      expect(tab.getAttribute('aria-selected')).toBe('true');
      expect(screen.getByRole('status').textContent).toBe('Loading preview…');
      refuse({ accepted: false, reason: 'missing' });
      await screen.findByText('This file is no longer there.');
      expect(screen.getByRole('tab', { name: path.split('/').at(-1) })).toBe(tab);
      expect(screen.getByRole('tabpanel').id).toBe(tab.getAttribute('aria-controls'));
      expect(screen.queryByRole('button', { name: 'Back', exact: true })).toBeNull();
      expect(request.mock.calls[0][1].input.reference).toBe(path);
      expect(request.mock.calls[0][1].input.sourceMessageOrCard).toMatchObject({
        kind: 'publication',
        id: publication().publicationId,
      });
      fireEvent.click(screen.getByRole('tab', { name: 'Your work · 1' }));
      await waitFor(() => expect(screen.queryByText('This file is no longer there.')).toBeNull());
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
    expect(card.textContent).toBe('Saved attachment · Layout report · HTML · 84 KB · Open preview');
    fireEvent.click(card);
    expect(artifactPreviewStack.value).toEqual([{ kind: 'artifact', artifactId: 'a-report' }]);
  });

  it('opens a path or PR link in a publication against that exact publication', async () => {
    render(
      <NeoPublicConversation conversation={conversation(publication({ revisionId: 'rev-2' }))} />
    );
    await waitFor(() => expect(screen.getByText('/synthetic/docs/design/layout.md')).toBeTruthy());
    fireEvent.click(screen.getByText('/synthetic/docs/design/layout.md'));
    expect(artifactPreviewStack.value).toEqual([
      {
        kind: 'reference',
        source: { kind: 'publication', id: publication().publicationId, revisionId: 'rev-2' },
        reference: '/synthetic/docs/design/layout.md',
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
      approvedAt: null,
      approvalQuestionId: null,
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
    expect(document.querySelector('[data-ask-todo="t1"]')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'All · 2', exact: true }));
    const row = screen
      .getByRole('dialog', { name: 'Layout' })
      .querySelector('[data-ask-todo="t1"]') as HTMLElement;
    expect(within(row).queryByRole('button', { name: 'Open preview: Layout report' })).toBeNull();
    fireEvent.click(
      within(row).getByRole('button', { name: 'Show details: Write the layout report' })
    );
    fireEvent.click(within(row).getByRole('button', { name: 'Open preview: Layout report' }));
    expect(artifactPreviewStack.value).toEqual([{ kind: 'artifact', artifactId: 'a-report' }]);
  });
});
