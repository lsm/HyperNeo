import './styles.css';
import { render } from 'preact';
import { useState } from 'preact/hooks';
import { InputTextarea } from './components/InputTextarea.tsx';
import { QueuePreviewTray, type QueuePreviewMessage } from './components/QueuePreviewTray.tsx';

interface PreviewScenario {
  title: string;
  caption: string;
  currentTurnMessages: QueuePreviewMessage[];
  nextTurnMessages: QueuePreviewMessage[];
  initialContent: string;
  working: boolean;
}

const baseTime = Date.now();

function makeMessage(
  id: string,
  status: 'enqueued' | 'deferred',
  text: string,
  offsetMs: number
): QueuePreviewMessage {
  return {
    dbId: `db-${id}`,
    uuid: `uuid-${id}`,
    timestamp: baseTime + offsetMs,
    status,
    text,
  };
}

const scenarios: PreviewScenario[] = [
  {
    title: 'Idle composer',
    caption: 'No queued messages, normal send action.',
    currentTurnMessages: [],
    nextTurnMessages: [],
    initialContent: 'Can you summarize this branch before we ship it?',
    working: false,
  },
  {
    title: 'Steer current turn',
    caption: 'A message already queued for the running turn.',
    currentTurnMessages: [
      makeMessage('now-1', 'enqueued', 'Also inspect the queue persistence path.', 1000),
    ],
    nextTurnMessages: [],
    initialContent: 'Mention the frontend regression first.',
    working: true,
  },
  {
    title: 'Deferred next turn',
    caption: 'A message waiting until the agent becomes idle.',
    currentTurnMessages: [],
    nextTurnMessages: [
      makeMessage(
        'next-1',
        'deferred',
        'After this turn, write focused tests for Tab queueing.',
        2000
      ),
    ],
    initialContent: 'Queue this follow-up for later.',
    working: true,
  },
  {
    title: 'Mixed queue',
    caption: 'Both groups populated, with every pending row visible.',
    currentTurnMessages: [
      makeMessage(
        'now-2',
        'enqueued',
        'Patch the composer labels while the agent is still running.',
        3000
      ),
      makeMessage('now-3', 'enqueued', 'Keep the current response concise and actionable.', 4000),
      makeMessage('now-4', 'enqueued', 'Do not discard the draft if send fails.', 5000),
    ],
    nextTurnMessages: [
      makeMessage('next-2', 'deferred', 'Then run the web typecheck.', 6000),
      makeMessage(
        'next-3',
        'deferred',
        'Open a browser preview and inspect the compact tray at desktop width.',
        7000
      ),
      makeMessage('next-4', 'deferred', 'Try the same layout on a narrow viewport.', 8000),
      makeMessage('next-5', 'deferred', 'Decide whether queued rows should become editable.', 9000),
    ],
    initialContent: 'This draft has two available actions while the agent is working.',
    working: true,
  },
  {
    title: 'Multiline busy composer',
    caption: 'Button placement when the textarea grows.',
    currentTurnMessages: [
      makeMessage(
        'now-5',
        'enqueued',
        'Use the existing design tokens and avoid a new surface style.',
        10000
      ),
    ],
    nextTurnMessages: [
      makeMessage('next-6', 'deferred', 'Follow up with UX notes after implementation.', 11000),
    ],
    initialContent:
      'This is a longer draft that wraps onto several lines so the queue and steer buttons stay pinned to the bottom edge of the composer.',
    working: true,
  },
];

function ScenarioCard({ scenario }: { scenario: PreviewScenario }) {
  const [content, setContent] = useState(scenario.initialContent);
  const [currentTurnMessages, setCurrentTurnMessages] = useState(scenario.currentTurnMessages);
  const [nextTurnMessages, setNextTurnMessages] = useState(scenario.nextTurnMessages);

  return (
    <section class="min-w-0 rounded-xl border border-line bg-surface/60 p-3 shadow-xl shadow-black/20">
      <div class="mb-3 flex items-start justify-between gap-3">
        <div>
          <h2 class="text-sm font-semibold text-fg">{scenario.title}</h2>
          <p class="mt-1 text-xs leading-5 text-fg-faint">{scenario.caption}</p>
        </div>
        <span
          class={`shrink-0 rounded-full border px-2 py-0.5 text-[11px] ${
            scenario.working
              ? 'border-warning/30 bg-warning/10 text-warning-soft'
              : 'border-line-strong bg-surface-raised text-fg-muted'
          }`}
        >
          {scenario.working ? 'Working' : 'Idle'}
        </span>
      </div>
      <QueuePreviewTray
        currentTurnMessages={currentTurnMessages}
        nextTurnMessages={nextTurnMessages}
        className="mb-2"
        onDeferMessage={(queued) => {
          setCurrentTurnMessages((messages) =>
            messages.filter((message) => message.dbId !== queued.dbId)
          );
          setNextTurnMessages((messages) => [...messages, { ...queued, status: 'deferred' }]);
        }}
        onPromoteMessage={(queued) => {
          setNextTurnMessages((messages) =>
            messages.filter((message) => message.dbId !== queued.dbId)
          );
          setCurrentTurnMessages((messages) => [...messages, { ...queued, status: 'enqueued' }]);
        }}
        onRemoveMessage={(queued) => {
          setCurrentTurnMessages((messages) =>
            messages.filter((message) => message.dbId !== queued.dbId)
          );
          setNextTurnMessages((messages) =>
            messages.filter((message) => message.dbId !== queued.dbId)
          );
        }}
      />
      <InputTextarea
        content={content}
        onContentChange={setContent}
        onKeyDown={() => {}}
        onSubmit={() => {}}
        onQueue={() => {}}
        onStop={() => {}}
        isAgentWorking={scenario.working}
        transparent={true}
      />
    </section>
  );
}

function QueuePreviewApp() {
  return (
    <div class="min-h-dvh overflow-auto bg-app-content px-5 py-5 text-fg">
      <header class="mx-auto mb-5 max-w-7xl">
        <p class="text-xs font-medium uppercase tracking-wide text-fg-faint">Composer Preview</p>
        <h1 class="mt-2 text-2xl font-semibold tracking-normal text-fg">Steer and Queue States</h1>
      </header>
      <main class="mx-auto grid max-w-7xl min-w-0 gap-3 lg:grid-cols-2 xl:grid-cols-3">
        {scenarios.map((scenario) => (
          <ScenarioCard key={scenario.title} scenario={scenario} />
        ))}
      </main>
    </div>
  );
}

const root = document.getElementById('root');
if (!root) {
  throw new Error('Root element not found');
}

render(<QueuePreviewApp />, root);
