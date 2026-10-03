import type { NeoConcern, NeoConsultation, NeoWork } from '@hyperneo/shared/types/neo-context';
import type { NeoSnapshot } from '@hyperneo/shared/types/neo-snapshot';
import { Button } from '../components/ui/Button.tsx';
import { NeoIcon } from './NeoIcon.tsx';
import { NeoWorkCard } from './NeoWorkCard.tsx';
import { NeoConsultationCard } from './NeoConsultationCard.tsx';
import { NeoConcernBoardPanel } from './NeoConcernBoard.tsx';
import { NeoConcerns } from './NeoConcerns.tsx';
import type { NeoScene, NeoSceneRef } from './neo-scenes.ts';

export type NeoWorkSurfaceGroup = {
  readonly key: string;
  readonly label: string;
  readonly scenes: readonly NeoScene[];
};

export function NeoWorkSurface({
  snapshot,
  concerns,
  works,
  consultations,
  selectedId,
  groups,
  showGroups,
  listLabel,
  detail,
  detailWork,
  detailConsultation,
  busyWork,
  connected,
  publicConversation,
  onOpenConcern,
  onAction,
  onOpenScene,
  onCloseScene,
  onOpenHolder,
  questionSlot,
}: {
  snapshot: NeoSnapshot | null;
  concerns: NeoConcern[];
  works: NeoWork[];
  consultations: NeoConsultation[];
  selectedId: string | null;
  groups: readonly NeoWorkSurfaceGroup[];
  showGroups: boolean;
  listLabel: string;
  detail: NeoScene | null;
  detailWork: NeoWork | null;
  detailConsultation: Extract<NeoScene['receipt'], { kind: 'consultation' }> | null;
  busyWork: string | null;
  connected: boolean;
  publicConversation: boolean;
  onOpenConcern: (id: string | null) => void;
  onAction: (id: string, action: 'start' | 'cancel' | 'stop-waiting') => void;
  onOpenScene: (ref: NeoSceneRef) => void;
  onCloseScene: () => void;
  onOpenHolder: (id: string | null) => void;
  questionSlot?: (id: string, node: HTMLElement | null, previous: HTMLElement | null) => void;
}) {
  const disabled = !connected || !!busyWork;
  const holder = (concernId: string) =>
    concerns.find((concern) => concern.id === concernId)?.title ?? 'Your context holder';
  return (
    <>
      <NeoConcerns
        concerns={concerns}
        works={works}
        consultations={consultations}
        selectedId={selectedId}
        onOpen={(id) => onOpenConcern(id)}
      />
      <div class="neo-scene-list" role="region" aria-label={listLabel}>
        {detail ? (
          <section
            aria-label={detailWork ? 'Selected work' : 'Selected context check'}
            class="neo-scene-detail space-y-3"
          >
            <Button
              variant="ghost"
              size="sm"
              onClick={onCloseScene}
              icon={<NeoIcon name="back" />}
              aria-label="Back to scenes"
            >
              Back to scenes
            </Button>
            {detailWork && (
              <NeoWorkCard
                key={detail.ref.id}
                work={detailWork}
                busy={busyWork === detailWork.id}
                disabled={disabled}
                onAction={onAction}
                questionSlot={questionSlot}
              />
            )}
            {detailConsultation && (
              <NeoConsultationCard
                consultation={detailConsultation}
                label={`Context check for ${holder(detailConsultation.concernId)}`}
                holderName={holder(detailConsultation.concernId)}
                busy={busyWork === detailConsultation.id}
                disabled={disabled}
                onOpenHolder={onOpenHolder}
                onStopWaiting={(id) => onAction(id, 'stop-waiting')}
              />
            )}
          </section>
        ) : null}
        {publicConversation && detail && groups.every((group) => !group.scenes.length) && (
          <p class="text-sm text-fg-muted">No other scenes right now.</p>
        )}
        {showGroups &&
          groups.map((group) =>
            group.scenes.length === 0 ? null : (
              <section
                key={group.key}
                aria-label={group.label}
                class="mt-6 space-y-3"
                data-scene-group={group.key}
              >
                <h2 class="text-xs font-medium text-fg-muted">
                  {group.label} · {group.scenes.length}
                </h2>
                {group.scenes.map((scene) =>
                  scene.receipt.kind === 'work' ? (
                    <NeoWorkCard
                      key={JSON.stringify(scene.ref)}
                      work={scene.receipt}
                      busy={busyWork === scene.ref.id}
                      disabled={disabled}
                      onAction={onAction}
                      onOpen={() => onOpenScene(scene.ref)}
                      presentation={
                        publicConversation && group.key !== 'attention' ? 'summary' : 'detail'
                      }
                      questionSlot={questionSlot}
                    />
                  ) : (
                    <NeoConsultationCard
                      key={JSON.stringify(scene.ref)}
                      consultation={scene.receipt}
                      label={`Context check for ${holder(scene.receipt.concernId)}`}
                      holderName={holder(scene.receipt.concernId)}
                      busy={busyWork === scene.ref.id}
                      disabled={disabled}
                      onOpen={() => onOpenScene(scene.ref)}
                      onOpenHolder={onOpenHolder}
                      onStopWaiting={(id) => onAction(id, 'stop-waiting')}
                      presentation={group.key === 'attention' ? 'detail' : 'summary'}
                    />
                  )
                )}
              </section>
            )
          )}
      </div>
      <NeoConcernBoardPanel snapshot={snapshot} concernId={selectedId} />
    </>
  );
}
