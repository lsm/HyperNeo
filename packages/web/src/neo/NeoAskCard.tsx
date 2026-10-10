import type { ComponentChildren } from 'preact';
import { useState } from 'preact/hooks';
import { Dropdown } from '../components/ui/Dropdown.tsx';
import { IconButton } from '../components/ui/IconButton.tsx';
import {
  NeoAppMark,
  NeoChatMark,
  NeoMoreIcon,
  NeoStatusChip,
  neoCardClass,
  neoFooterClass,
  neoPlainClass,
  neoSecondaryClass,
} from './NeoCardParts.tsx';
import { NeoIcon } from './NeoIcon.tsx';
import { type NeoAskOutcome, type NeoAskView, neoAskOpenTarget } from './neo-asks.ts';
import type { NeoScene, NeoSceneDrivers } from './neo-scenes.ts';
import { neoWorkOpenLabel } from './work-actions.ts';
import { neoWorkDriverLogo } from './work-driver.ts';

const tones = {
  attention: 'text-warning bg-warning/10',
  running: 'text-accent bg-accent/10',
  achieved: 'text-success bg-success/10',
  ended: 'text-fg-muted bg-fill-soft',
};

function stepGlyph(scene: NeoScene, done: boolean): { mark: string; color: string } {
  if (done) return { mark: '✓', color: 'text-success' };
  if (scene.group === 'attention') return { mark: '!', color: 'text-warning' };
  if (scene.group === 'running') return { mark: '●', color: 'text-accent' };
  if (scene.receipt.kind === 'work' && scene.receipt.status === 'cancelled')
    return { mark: '–', color: 'text-fg-faint' };
  return { mark: '!', color: 'text-warning' };
}

function StepRow({ scene, done }: { scene: NeoScene; done: boolean }) {
  const glyph = stepGlyph(scene, done);
  const title = scene.receipt.kind === 'work' ? scene.receipt.title : scene.label;
  return (
    <div data-ask-step={scene.ref.id} class="flex min-w-0 items-center gap-2 text-sm">
      <span aria-hidden="true" class={`w-3 shrink-0 text-center text-xs ${glyph.color}`}>
        {glyph.mark}
      </span>
      <span class="min-w-0 flex-1 truncate" title={title}>
        {title}
      </span>
      <span class="max-w-[45%] shrink-0 truncate text-xs text-fg-faint">{scene.label}</span>
    </div>
  );
}

export function NeoAskCard({
  view,
  drivers,
  disabled = false,
  onSettle,
  onOpen,
  renderCard,
}: {
  view: NeoAskView;
  drivers?: NeoSceneDrivers;
  disabled?: boolean;
  onSettle?: (outcome: NeoAskOutcome) => void;
  onOpen?: (workId: string) => void;
  renderCard?: (scene: NeoScene) => ComponentChildren;
}) {
  const [open, setOpen] = useState(false);
  const { ask } = view;
  const tone =
    view.group === 'attention'
      ? 'attention'
      : ask.status === 'achieved'
        ? 'achieved'
        : view.group === 'outcomes'
          ? 'ended'
          : 'running';
  const steps = view.scenes.length;
  const single = steps === 1 ? view.scenes[0] : undefined;
  const target = neoAskOpenTarget(view, drivers);
  const openName = `Open ${ask.title}`;
  const openControl =
    target &&
    (target.link ? (
      <a href={target.link} class={neoSecondaryClass} aria-label={openName}>
        <NeoAppMark logo={neoWorkDriverLogo(target.driver)} />
        {neoWorkOpenLabel(target.driver)}
      </a>
    ) : (
      onOpen && (
        <button
          type="button"
          class={neoSecondaryClass}
          aria-label={openName}
          onClick={() => onOpen(target.work.id)}
        >
          <NeoChatMark />
          Open chat
        </button>
      )
    ));
  return (
    <article aria-label={ask.title} data-ask={ask.id} class={neoCardClass}>
      <div class="flex min-h-7 items-center gap-2">
        <NeoStatusChip
          tone={tone}
          colors={tones[tone]}
          label={view.label}
          pulse={tone === 'running'}
        />
        <span class="flex-1" />
        {!view.settled && view.total > 0 && (
          <span class="shrink-0 text-xs text-fg-muted">
            {view.done} of {view.total} done
          </span>
        )}
        {onSettle && ask.status !== 'achieved' && ask.status !== 'abandoned' && (
          <Dropdown
            position="right"
            items={[
              { label: 'Mark done', onClick: () => onSettle('achieved'), disabled },
              {
                label: 'Drop this ask',
                onClick: () => onSettle('abandoned'),
                danger: true,
                disabled,
              },
            ]}
            trigger={
              <IconButton title="Ask actions" size="sm" class="text-fg-faint">
                <NeoMoreIcon />
              </IconButton>
            }
          />
        )}
      </div>
      <h3 class="mt-2 line-clamp-3 break-words text-base font-semibold leading-snug">
        {ask.title}
      </h3>
      {view.summary && (
        <p class="mt-1.5 line-clamp-2 break-words text-sm text-fg-muted">{view.summary}</p>
      )}
      {steps > 0 && (
        <div class="mt-3 space-y-2 border-l-2 border-line pl-3">
          {view.scenes.map((scene) =>
            scene.group === 'attention' ? (
              renderCard?.(scene)
            ) : (
              <StepRow key={scene.ref.id} scene={scene} done={view.doneIds.has(scene.ref.id)} />
            )
          )}
        </div>
      )}
      {open && (
        <div data-ask-details class="mt-3 space-y-3">
          <div class="text-sm text-fg-muted">
            <p class="text-xs font-medium text-fg-faint">Done when</p>
            <p class="mt-1 whitespace-pre-wrap break-words">{ask.doneWhen}</p>
          </div>
          {ask.outcome && ask.outcome.trim() !== view.summary && (
            <div class="text-sm text-fg-muted">
              <p class="text-xs font-medium text-fg-faint">Outcome</p>
              <p class="mt-1 whitespace-pre-wrap break-words">{ask.outcome}</p>
            </div>
          )}
          {single && single.group !== 'attention' && renderCard?.(single)}
        </div>
      )}
      <div class={neoFooterClass}>
        {openControl}
        <span class="flex-1" />
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          class={neoPlainClass}
        >
          Details
          <NeoIcon
            name="chevron"
            class={`!h-3.5 !w-3.5 transition-transform${open ? '' : ' rotate-180'}`}
          />
        </button>
      </div>
    </article>
  );
}
