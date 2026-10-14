import superpipe, { type PipelineAPI } from 'superpipe';
import type { NeoAskGroups, NeoAskView } from './neo-asks.ts';
import type { NeoSceneCards } from './neo-scenes.ts';

export type NeoAskSummary = {
  readonly line: string;
  readonly asks: readonly { readonly id: string; readonly title: string }[];
};

type Tally = { running: number; needsYou: number; ci: number; review: number };

const words = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];
const count = (n: number) => words[n] ?? String(n);

export function neoLiveAsks(groups: NeoAskGroups): readonly NeoAskView[] {
  return [...groups.asks.attention, ...groups.asks.running].filter((view) => !view.settled);
}

export function tallyNeoLiveAsks(asks: readonly NeoAskView[], cards: NeoSceneCards): Tally {
  const waiting = (view: NeoAskView, label: string) =>
    view.scenes.some((scene) => cards.get(scene.ref.id)?.pr?.label.startsWith(label));
  return {
    running: asks.filter((view) => view.group === 'running').length,
    needsYou: asks.filter((view) => view.group === 'attention').length,
    ci: asks.filter((view) => waiting(view, 'Waiting on CI')).length,
    review: asks.filter((view) => waiting(view, 'Waiting on review')).length,
  };
}

export function neoAskSummaryLine({ running, needsYou, ci, review }: Tally): string | null {
  const parts = [
    running > 0 && `${count(running)} ${running === 1 ? 'ask' : 'asks'} running`,
    needsYou > 0 &&
      (running > 0
        ? `${count(needsYou)} ${needsYou === 1 ? 'needs' : 'need'} you`
        : `${count(needsYou)} ${needsYou === 1 ? 'ask needs' : 'asks need'} you`),
    ci > 0 && `${count(ci)} waiting on CI`,
    review > 0 && `${count(review)} waiting on review`,
  ].filter((part): part is string => !!part);
  if (!parts.length) return null;
  const line = parts.join(' · ');
  return line[0].toUpperCase() + line.slice(1);
}

export function presentNeoAskSummary(
  asks: readonly NeoAskView[],
  line: string | null
): { value: NeoAskSummary } | { reason: null } {
  if (!line) return { reason: null };
  return {
    value: { line, asks: asks.map((view) => ({ id: view.ask.id, title: view.ask.title })) },
  };
}

export const projectNeoAskSummary = (superpipe({})('neo-ask-summary') as PipelineAPI)
  .input(['groups', 'cards'])
  .pipe(neoLiveAsks, 'groups', 'asks')
  .pipe(tallyNeoLiveAsks, ['asks', 'cards'], 'tally')
  .pipe(neoAskSummaryLine, 'tally', 'line')
  .pipe(presentNeoAskSummary, ['asks', 'line'], 'result:summary')
  .end('summary') as (groups: NeoAskGroups, cards: NeoSceneCards) => NeoAskSummary | null;

export function NeoAskSummaryLine({
  summary,
  onOpenAsk,
}: {
  summary: NeoAskSummary | null;
  onOpenAsk: (askId: string) => void;
}) {
  if (!summary) return null;
  return (
    <nav class="neo-ask-summary" aria-label="Live asks">
      <span class="shrink-0">{summary.line}</span>
      <span class="neo-ask-summary-links">
        {summary.asks.map((ask) => (
          <button
            key={ask.id}
            type="button"
            class="neo-ask-summary-link"
            title={ask.title}
            onClick={() => onOpenAsk(ask.id)}
          >
            {ask.title}
          </button>
        ))}
      </span>
    </nav>
  );
}
