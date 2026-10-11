import type { NeoAskItem } from '@hyperneo/shared/types/neo-snapshot';
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
  neoPrimaryClass,
  neoSecondaryClass,
} from './NeoCardParts.tsx';
import { NeoIcon } from './NeoIcon.tsx';
import {
  type NeoAskOutcome,
  type NeoAskView,
  neoAskApproval,
  neoAskOpenTarget,
} from './neo-asks.ts';
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
    <div data-ask-step={scene.ref.id} class="flex min-w-0 items-baseline gap-2 text-sm">
      <span aria-hidden="true" class={`w-3 shrink-0 text-center text-xs ${glyph.color}`}>
        {glyph.mark}
      </span>
      <span class="min-w-0 flex-1">
        <span class="line-clamp-2 break-words" title={title}>
          {title}
        </span>
        <span class="block truncate text-xs text-fg-faint">{scene.label}</span>
      </span>
    </div>
  );
}

const itemGlyphs: Record<NeoAskItem['state'], { mark: string; color: string }> = {
  met: { mark: '✓', color: 'text-success' },
  needs_you: { mark: '!', color: 'text-warning' },
  pending: { mark: '○', color: 'text-fg-faint' },
};

function ItemRow({
  item,
  onDone,
  disabled,
}: {
  item: NeoAskItem;
  onDone?: (itemId: string) => void;
  disabled?: boolean;
}) {
  const glyph = itemGlyphs[item.state];
  const tags = [
    item.removed && 'removed',
    item.addedAt !== null && !item.removed && 'added',
    item.state === 'met' && item.metBy === 'daemon' && 'verified',
    item.state === 'needs_you' && 'needs you',
  ].filter(Boolean);
  return (
    <li data-ask-item={item.id} class="flex min-w-0 items-baseline gap-2 text-sm">
      <span aria-hidden="true" class={`w-3 shrink-0 text-center text-xs ${glyph.color}`}>
        {glyph.mark}
      </span>
      <span class="min-w-0 flex-1">
        <span
          class={`break-words ${item.removed ? 'text-fg-faint line-through' : item.state === 'met' ? 'text-fg-muted' : 'text-fg'}`}
        >
          {item.text}
        </span>
        {tags.length > 0 && <span class="ml-2 text-xs text-fg-faint">{tags.join(' · ')}</span>}
        {item.evidence && item.state === 'met' && (
          <span class="block truncate text-xs text-fg-faint" title={item.evidence}>
            {item.evidence}
          </span>
        )}
      </span>
      {onDone && item.state === 'needs_you' && !item.removed && (
        <button
          type="button"
          class={neoSecondaryClass}
          disabled={disabled}
          aria-label={`Mark done: ${item.text}`}
          onClick={() => onDone(item.id)}
        >
          Done
        </button>
      )}
    </li>
  );
}

function Checklist({
  items,
  label,
  onDone,
  disabled,
}: {
  items: readonly NeoAskItem[];
  label: string;
  onDone?: (itemId: string) => void;
  disabled?: boolean;
}) {
  return (
    <ul aria-label={label} class="space-y-1.5">
      {items.map((item) => (
        <ItemRow key={item.id} item={item} onDone={onDone} disabled={disabled} />
      ))}
    </ul>
  );
}

export function NeoAskCard({
  view,
  drivers,
  disabled = false,
  onSettle,
  onDone,
  onApprove,
  onOpen,
  renderCard,
}: {
  view: NeoAskView;
  drivers?: NeoSceneDrivers;
  disabled?: boolean;
  onSettle?: (outcome: NeoAskOutcome) => void;
  onDone?: (itemId: string) => void;
  onApprove?: () => void;
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
  const needsYouItems = view.settled
    ? []
    : view.items.filter((item) => item.state === 'needs_you' && !item.removed);
  const canApprove =
    !view.settled &&
    !ask.approvedAt &&
    view.scenes.some(
      (scene) => scene.receipt.kind === 'work' && scene.receipt.status === 'proposed'
    );
  const approval = neoAskApproval(ask, Date.now());
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
        {!view.settled && !!ask.approvedAt && (
          <span
            class="shrink-0 text-xs text-fg-muted"
            title="You approved this ask: Neo starts its steps without asking again."
          >
            Approved
          </span>
        )}
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
      {needsYouItems.length > 0 && (
        <div data-ask-needs-you class="mt-3 rounded-lg bg-warning/10 px-3 py-2">
          <Checklist items={needsYouItems} label="Needs you" onDone={onDone} disabled={disabled} />
        </div>
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
            {view.items.length > 0 ? (
              <div class="mt-1.5">
                <Checklist items={view.items} label="Done when" />
              </div>
            ) : (
              <p class="mt-1 whitespace-pre-wrap break-words">{ask.doneWhen}</p>
            )}
          </div>
          {!view.settled && approval && (
            <div class="text-sm text-fg-muted">
              <p class="text-xs font-medium text-fg-faint">Approval</p>
              <p class="mt-1 flex flex-wrap items-center gap-x-3">
                <span>{approval.line}</span>
                {approval.spent && onApprove && (
                  <button
                    type="button"
                    class={neoPlainClass}
                    disabled={disabled}
                    onClick={onApprove}
                  >
                    Approve again
                  </button>
                )}
              </p>
            </div>
          )}
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
        {canApprove && onApprove && (
          <button
            type="button"
            class={neoPrimaryClass}
            disabled={disabled}
            title="Let Neo start this ask's steps without asking for each one. Deploys and destructive steps still ask you."
            onClick={onApprove}
          >
            Approve all steps
          </button>
        )}
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
