import { useEffect, useRef, useState } from 'preact/hooks';
import { lazy, Suspense } from 'preact/compat';
import type { Space, SpaceWorkflow } from '@hyperneo/shared';
import { Tab, TabGroup, TabList, TabPanel, TabPanels } from '@hyperneo/ui';
import { spaceStore } from '../../lib/space-store';
import { currentSpaceConfigureTabSignal, currentSpaceIdSignal } from '../../lib/signals';
import { navigateToSpaceConfigure } from '../../lib/router';
import { cn } from '../../lib/utils';

const SpaceWorkerAgentList = lazy(() =>
  import('./SpaceWorkerAgentList').then((m) => ({ default: m.SpaceWorkerAgentList }))
);
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
    <div class="w-5 h-5 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
  </div>
);

type ConfigureTab = 'agents' | 'workflows' | 'settings';

const CONFIGURE_TABS: Array<{
  id: ConfigureTab;
  label: string;
  count: (args: { agentCount: number; workflowCount: number }) => number;
}> = [
  { id: 'agents', label: 'Worker Agents', count: ({ agentCount }) => agentCount },
  { id: 'workflows', label: 'Workflows', count: ({ workflowCount }) => workflowCount },
  { id: 'settings', label: 'General', count: () => 1 },
];

interface SpaceConfigurePageProps {
  space: Space;
}

export function SpaceConfigurePage({ space }: SpaceConfigurePageProps) {
  const workflows = spaceStore.workflows.value;
  const workerAgentCount = spaceStore.agents.value.length;
  const configLoaded = spaceStore.configDataLoaded.value;

  const activeTab = currentSpaceConfigureTabSignal.value;

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
    activeTab === 'workflows' &&
    workflowEditId !== null &&
    (workflowEditId === 'new' || editingWorkflow !== undefined);
  const selectedIndex = Math.max(
    0,
    CONFIGURE_TABS.findIndex((tab) => tab.id === activeTab)
  );

  if (!configLoaded) {
    return (
      <div class="flex-1 flex items-center justify-center">
        <div class="w-5 h-5 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div class="flex h-full flex-col overflow-hidden">
      <div class="mx-auto flex min-h-0 w-full max-w-7xl flex-1 flex-col px-4 pb-4 sm:px-6">
        {!showWorkflowEditor && (
          <TabGroup
            class="flex min-h-0 flex-1 flex-col"
            selectedIndex={selectedIndex}
            onChange={(index: number) =>
              navigateToSpaceConfigure(spaceId, CONFIGURE_TABS[index]?.id ?? 'agents')
            }
          >
            <TabList
              class="flex h-[52px] flex-shrink-0 items-center gap-1 border-b border-white/10"
              data-testid="space-configure-tab-bar"
            >
              {CONFIGURE_TABS.map((tab) => (
                <Tab
                  key={tab.id}
                  data-testid={`space-configure-tab-${tab.id}`}
                  class={cn(
                    'flex h-[52px] items-center gap-2 border-b-2 px-3 text-sm font-medium transition-colors',
                    activeTab === tab.id
                      ? 'border-blue-400 text-gray-100'
                      : 'border-transparent text-gray-400 hover:text-gray-200'
                  )}
                >
                  <span>{tab.label}</span>
                  <span class="rounded-full bg-white/5 px-1.5 py-px text-xs text-gray-400">
                    {tab.count({
                      agentCount: workerAgentCount,
                      workflowCount: workflows.length,
                    })}
                  </span>
                </Tab>
              ))}
            </TabList>

            <TabPanels class="min-h-0 flex-1 overflow-hidden">
              <TabPanel class="h-full min-h-0 overflow-hidden">
                <Suspense fallback={lazyFallback}>
                  <div class="h-full min-h-0 pt-4">
                    <SpaceWorkerAgentList />
                  </div>
                </Suspense>
              </TabPanel>
              <TabPanel class="h-full min-h-0 overflow-hidden">
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
              </TabPanel>
              <TabPanel class="h-full min-h-0 overflow-hidden">
                <Suspense fallback={lazyFallback}>
                  <SpaceSettings space={space} />
                </Suspense>
              </TabPanel>
            </TabPanels>
          </TabGroup>
        )}

        {showWorkflowEditor && (
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
        )}
      </div>
    </div>
  );
}
