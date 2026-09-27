import { useEffect, useRef, useState } from 'preact/hooks';
import { lazy, Suspense } from 'preact/compat';
import { Tab, TabGroup, TabList } from '@hyperneo/ui';
import type { Space, SpaceWorkflow } from '@hyperneo/shared';
import { spaceStore } from '../../lib/space-store';
import { currentSpaceIdSignal, currentSpaceSettingsTabSignal } from '../../lib/signals';
import type { SpaceSettingsTab } from '../../lib/signals';
import { navigateToSpaceConfigure } from '../../lib/router';
import { cn } from '../../lib/utils';

const SpaceSettings = lazy(() =>
  import('./SpaceSettings').then((m) => ({ default: m.SpaceSettings }))
);
const WorkflowList = lazy(() =>
  import('./WorkflowList').then((m) => ({ default: m.WorkflowList }))
);
const VisualWorkflowEditor = lazy(() =>
  import('./visual-editor/VisualWorkflowEditor').then((m) => ({
    default: m.VisualWorkflowEditor,
  }))
);

const lazyFallback = (
  <div class="flex-1 flex items-center justify-center py-12">
    <div class="w-5 h-5 border-2 border-accent border-t-transparent rounded-full animate-spin" />
  </div>
);

const CONFIGURE_TABS: Array<{ id: SpaceSettingsTab; label: string }> = [
  { id: 'general', label: 'General' },
  { id: 'runtime', label: 'Runtime' },
  { id: 'tools', label: 'Tools' },
  { id: 'events', label: 'Events' },
  { id: 'agent-templates', label: 'Agents' },
  { id: 'workflow-templates', label: 'Workflows' },
  { id: 'advanced', label: 'Advanced' },
];

interface SpaceConfigurePageProps {
  space: Space;
}

export function SpaceConfigurePage({ space }: SpaceConfigurePageProps) {
  const workflows = spaceStore.workflows.value;
  const configLoaded = spaceStore.configDataLoaded.value;

  const activeTab = currentSpaceSettingsTabSignal.value;

  useEffect(() => {
    spaceStore.ensureConfigData().catch(() => {});
  }, [space.id]);
  const spaceId = currentSpaceIdSignal.value ?? '';
  const [workflowEditId, setWorkflowEditId] = useState<string | null>(null);
  const [editingWorkflow, setEditingWorkflow] = useState<SpaceWorkflow | undefined>(undefined);

  useEffect(() => {
    setWorkflowEditId(null);
    setEditingWorkflow(undefined);
  }, [space.id]);

  const workflowVersion = spaceStore.workflowVersions.value.get(workflowEditId ?? '') ?? 0;
  const lastFetchedEditIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (!workflowEditId || workflowEditId === 'new') {
      setEditingWorkflow(undefined);
      lastFetchedEditIdRef.current = null;
      return;
    }
    let cancelled = false;
    const isSwitchingId = lastFetchedEditIdRef.current !== workflowEditId;
    if (isSwitchingId) {
      setEditingWorkflow(undefined);
    }
    lastFetchedEditIdRef.current = workflowEditId;
    spaceStore.fetchWorkflowDetail(workflowEditId).then((wf) => {
      if (cancelled) return;
      if (wf) {
        setEditingWorkflow(wf);
      } else {
        setWorkflowEditId(null);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [workflowEditId, workflowVersion]);

  const showWorkflowEditor =
    activeTab === 'workflow-templates' &&
    workflowEditId !== null &&
    (workflowEditId === 'new' || editingWorkflow !== undefined);

  if (!configLoaded) {
    return (
      <div class="flex-1 flex items-center justify-center">
        <div class="w-5 h-5 border-2 border-accent border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div class="flex h-full flex-col overflow-hidden">
      <div class="mx-auto flex min-h-0 w-full max-w-7xl flex-1 flex-col px-4 pb-4 sm:px-6">
        {!showWorkflowEditor && (
          <TabGroup
            class="mb-4 self-start"
            selectedIndex={Math.max(
              0,
              CONFIGURE_TABS.findIndex((tab) => tab.id === activeTab)
            )}
            onChange={(index: number) =>
              navigateToSpaceConfigure(spaceId, CONFIGURE_TABS[index]?.id ?? 'general')
            }
          >
            <TabList
              class="st-tabs"
              data-testid="space-configure-tab-bar"
              aria-label="Configure sections"
            >
              {CONFIGURE_TABS.map((tab) => (
                <Tab
                  key={tab.id}
                  class={cn('st-tab', activeTab === tab.id && 'st-tab-on')}
                  data-testid={`space-configure-tab-${tab.id}`}
                >
                  {tab.label}
                </Tab>
              ))}
            </TabList>
          </TabGroup>
        )}

        {showWorkflowEditor ? (
          <Suspense fallback={lazyFallback}>
            <div class="min-h-0 flex-1 overflow-hidden">
              <VisualWorkflowEditor
                key={workflowEditId}
                workflow={editingWorkflow}
                onSave={() => undefined}
                onCancel={() => setWorkflowEditId(null)}
              />
            </div>
          </Suspense>
        ) : activeTab === 'workflow-templates' ? (
          <Suspense fallback={lazyFallback}>
            <div class="h-full min-h-0 pt-4">
              <WorkflowList
                spaceId={space.id}
                spaceName={space.name}
                workflows={workflows}
                onCreateWorkflow={() => setWorkflowEditId('new')}
                onEditWorkflow={(id) => setWorkflowEditId(id)}
              />
            </div>
          </Suspense>
        ) : (
          <Suspense fallback={lazyFallback}>
            <SpaceSettings space={space} tab={activeTab} />
          </Suspense>
        )}
      </div>
    </div>
  );
}
