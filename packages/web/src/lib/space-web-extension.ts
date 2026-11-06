import { type ComponentChild, h } from 'preact';
import { GoalDetailPanel } from '../components/space/GoalDetailPanel.tsx';
import { ScopeDetailPanel } from '../components/space/ScopeDetailPanel.tsx';
import { SpaceMain } from '../components/space/SpaceMain.tsx';
import { SpaceSidebar } from '../components/space/SpaceSidebar.tsx';
import { navigateToSpaceAgent } from './space-router.ts';
import { type ExtensionPanelTarget, navSectionSignal, rightPanelTargetSignal } from './signals.ts';
import {
  currentSpaceCanonicalIdSignal,
  currentSpaceGoalIdSignal,
  currentSpaceIdSignal,
  currentSpaceScopeIdSignal,
  currentSpaceViewModeSignal,
} from './space-signals.ts';
import { spaceStore } from './space-store.ts';
import type { ExtensionSessionAgent, SpaceWebExtension } from './web-extensions.ts';

function panelTarget(): ExtensionPanelTarget | null {
  const routeSpaceId = currentSpaceIdSignal.value;
  const owner = currentSpaceCanonicalIdSignal.value ?? routeSpaceId;
  if (navSectionSignal.value !== 'spaces' || routeSpaceId === null || !owner) return null;
  const viewMode = currentSpaceViewModeSignal.value;
  const goalId = currentSpaceGoalIdSignal.value;
  const scopeId = currentSpaceScopeIdSignal.value;
  if (viewMode === 'goals' && goalId)
    return { type: 'extension', panel: 'goal', owner, item: goalId };
  if (viewMode === 'forge' && scopeId)
    return { type: 'extension', panel: 'scope', owner, item: scopeId };
  return null;
}

function renderPanel({ panel, owner, item }: ExtensionPanelTarget): ComponentChild {
  if (panel === 'goal')
    return h(GoalDetailPanel, {
      spaceId: owner,
      navigationSpaceId: currentSpaceIdSignal.value ?? owner,
      goalId: item,
    });
  return panel === 'scope' ? h(ScopeDetailPanel, { spaceId: owner, scopeId: item }) : null;
}

function sessionAgent(sessionId: string): ExtensionSessionAgent | null {
  const agent = spaceStore.agents.value.find((candidate) => candidate.sessionId === sessionId);
  if (!agent) return null;
  const slug = spaceStore.space.value?.slug ?? null;
  const row = (label: string, value: string | number | null | undefined) =>
    value ? [{ label, value: String(value) }] : [];
  return {
    rows: [
      { label: 'Name', value: agent.displayName },
      { label: 'Handle', value: `@${agent.handle}` },
      { label: 'Status', value: agent.status },
      ...row('Autonomy', agent.autonomyLevel ? `L${agent.autonomyLevel}` : null),
      ...row('Model', agent.model),
      ...row('Thinking', agent.thinkingLevel),
    ],
    instructions: agent.instructions ?? undefined,
    openSettings: slug
      ? () => {
          rightPanelTargetSignal.value = null;
          navigateToSpaceAgent(slug);
        }
      : undefined,
  };
}

export const spaceWebExtension: SpaceWebExtension = {
  shell: {
    activeChannel: () => {
      const spaceId = spaceStore.spaceId.value;
      return spaceId ? `space:${spaceId}` : null;
    },
    rejoinChannel: () => spaceStore.rejoinChannel(),
    refresh: () => spaceStore.refresh(),
    sessionRenamed: (sessionId, title) => spaceStore.updateSession(sessionId, { title }),
    panelTarget,
    Content: SpaceMain,
    sidebar: (section) => (section === 'spaces' ? SpaceSidebar : null),
    renderPanel,
    sessionAgent,
  },
  store: spaceStore,
};
