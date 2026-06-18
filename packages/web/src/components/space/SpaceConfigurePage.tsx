import { useEffect, useRef, useState } from 'preact/hooks';
import { lazy, Suspense } from 'preact/compat';
import type { Space, SpaceWorkflow } from '@neokai/shared';
import { Tab, TabGroup, TabList, TabPanel, TabPanels } from '@neokai/ui';
import { spaceStore } from '../../lib/space-store';
import { currentSpaceConfigureTabSignal, currentSpaceIdSignal } from '../../lib/signals';
import { getWorkerAgentsFromWorkflows } from './SpaceAgentList';
import { navigateToSpaceConfigure } from '../../lib/router';
import { cn } from '../../lib/utils';

const SpaceAgentList = lazy(() =>
  import('./SpaceAgentList').then((m) => ({ default: m.SpaceAgentList }))
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
  { id: 'agents', label: 'Agents', count: ({ agentCount }) => agentCount },
  { id: 'workflows', label: 'Workflows', count: ({ workflowCount }) => workflowCount },
  { id: 'settings', label: 'General', count: () => 1 },
];

interface SpaceConfigurePageProps {
  space: Space;
}

export function SpaceConfigurePage({ space }: SpaceConfigurePageProps) {
  const workflows = spaceStore.workflows.value;
  const workflowDetails = spaceStore.workflowDetails.value;
  const workerAgentCount = getWorkerAgentsFromWorkflows(workflowDetails).length;
  const configLoaded = spaceStore.configDataLoaded.value;

  useEffect(() => {
    spaceStore.ensureConfigData().catch(() => {});
    // Configure Agents view needs full workflow definitions (nodes + agent
    // slots) to render worker-agent cards; summaries exclude nodes. Loaded
    // lazily here so summary-only views don't pay the per-workflow RPC cost.
    spaceStore.ensureWorkflowDetails().catch(() => {});
    spaceStore.ensureNodeExecutions().catch(() => {});
  }, [space.id]);
  const activeTab = currentSpaceConfigureTabSignal.value;
  const spaceId = currentSpaceIdSignal.value ?? '';
  /** null = list view; 'new' = create editor; <id> = edit editor */
  const [workflowEditId, setWorkflowEditId] = useState<string | null>(null);
  const [editingWorkflow, setEditingWorkflow] = useState<SpaceWorkflow | undefined>(undefined);

  // Reset editor state when the space changes so we don't try to edit a
  // workflow belonging to the previous space.
  useEffect(() => {
    setWorkflowEditId(null);
    setEditingWorkflow(undefined);
  }, [space.id]);

  // Read the workflow version so the effect re-runs when the same workflow
  // is edited in place (spaceStore bumps the version on spaceWorkflow.updated).
  const workflowVersion = spaceStore.workflowVersions.value.get(workflowEditId ?? '') ?? 0;
  const lastFetchedEditIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (!workflowEditId || workflowEditId === 'new') {
      setEditingWorkflow(undefined);
      lastFetchedEditIdRef.current = null;
      return;
    }
    let cancelled = false;
    // Only clear editingWorkflow when switching to a different workflow ID.
    // When the same workflow is refreshed in place (version bump from a save
    // or remote update), keep the editor mounted so in-progress unsaved edits
    // are not discarded.
    const isSwitchingId = lastFetchedEditIdRef.current !== workflowEditId;
    if (isSwitchingId) {
      setEditingWorkflow(undefined);
    }
    lastFetchedEditIdRef.current = workflowEditId;
    // Fetch full workflow detail for editing — spaceStore.workflows only holds summaries
    spaceStore.fetchWorkflowDetail(workflowEditId).then((wf) => {
      if (cancelled) return;
      if (wf) {
        setEditingWorkflow(wf);
      } else {
        // Fetch failed or workflow was deleted concurrently — reset the edit
        // target so the user can retry by clicking Edit again.
        setWorkflowEditId(null);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [workflowEditId, workflowVersion]);

  // For edit mode, defer mounting the editor until the workflow detail has
  // loaded so VisualWorkflowEditor (which initializes from props on mount)
  // never receives stale or undefined data.
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
                    <SpaceAgentList />
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
                // Keep editor open after save; exit is explicit via Back/Cancel.
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
