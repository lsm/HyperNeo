import type { SpaceLongHorizonAgentTemplate } from '@hyperneo/shared';

const LONG_HORIZON_AGENT_TEMPLATES: SpaceLongHorizonAgentTemplate[] = [
  {
    key: 'coordinator.default',
    handle: 'coordinator',
    displayName: 'Coordinator',
    description:
      'Orchestrates goals, reminders, reactive subscriptions, and handoffs across the Space.',
    instructions:
      'Coordinate long-horizon Space activity. Keep goals moving, route work to suitable agents, maintain reminders, monitor event subscriptions, surface blockers early, and keep durable summaries current. Prefer creating clear tasks with owners over doing all work yourself.',
    suggestedAutonomyLevel: 2,
    suggestedEventSubscriptions: [
      {
        source: 'space',
        topic: 'task.*',
        filter: { statuses: ['blocked', 'review', 'done'] },
      },
      {
        source: 'space',
        topic: 'goal.*',
        filter: { statuses: ['active', 'blocked', 'done'] },
      },
    ],
    reminderDefaults: [
      {
        title: 'Review Space plan',
        body: 'Review active goals, blocked work, stale tasks, and needed follow-ups.',
        triggerType: 'cron',
        cronExpression: '0 9 * * 1',
        timezone: 'UTC',
      },
    ],
    ownershipPatterns: [
      {
        target: 'goal',
        relationship: 'manager',
        description: 'Manage cross-cutting recurring goals and delegate execution tasks.',
      },
      {
        target: 'forge_scope',
        relationship: 'watcher',
        description: 'Watch broad Forge scopes for new lessons and proposed work.',
      },
    ],
    toolPermissions: {},
  },
  {
    key: 'product-quality-manager.default',
    handle: 'product-quality-manager',
    displayName: 'Product Quality Manager',
    description:
      'Turns dogfood feedback, QA signals, and completed work into prioritized quality improvements.',
    instructions:
      'Own product quality learning loops. Review completed tasks, review feedback, QA artifacts, telemetry, and user dogfood notes. Identify bugs, UX gaps, reliability risks, and recurring friction. Convert useful findings into prioritized goals or tasks with evidence and preserve lessons for future work.',
    suggestedAutonomyLevel: 2,
    suggestedEventSubscriptions: [
      {
        source: 'space',
        topic: 'task.done',
        filter: { labels: ['neokai-product', 'quality'] },
      },
      {
        source: 'github',
        topic: 'pull_request.closed',
        filter: { merged: true },
      },
    ],
    reminderDefaults: [
      {
        title: 'Review quality signals',
        body: 'Review recent completed tasks, QA failures, dogfood notes, and unresolved quality findings.',
        triggerType: 'cron',
        cronExpression: '0 10 * * 1,4',
        timezone: 'UTC',
      },
    ],
    ownershipPatterns: [
      {
        target: 'goal',
        relationship: 'owner',
        description: 'Own recurring product-quality goals and keep progress summaries current.',
      },
      {
        target: 'forge_scope',
        relationship: 'manager',
        description: 'Manage Forge scopes for bugs, UX gaps, reliability, and workflow friction.',
      },
    ],
    toolPermissions: {},
  },
  {
    key: 'release-manager.default',
    handle: 'release-manager',
    displayName: 'Release Manager',
    description:
      'Coordinates release readiness, changelog inputs, validation gates, and post-release checks.',
    instructions:
      'Manage releases from readiness through follow-up. Track candidate changes, verify required checks, coordinate QA and approvals, prepare release notes inputs, watch deployment signals, and create follow-up tasks for regressions or missing validation.',
    suggestedAutonomyLevel: 2,
    suggestedEventSubscriptions: [
      {
        source: 'github',
        topic: 'pull_request.closed',
        filter: { merged: true, base: 'dev' },
      },
      {
        source: 'github',
        topic: 'workflow_run.completed',
        filter: { branches: ['dev'], conclusions: ['failure', 'success'] },
      },
    ],
    reminderDefaults: [
      {
        title: 'Check release readiness',
        body: 'Review merged changes, failing checks, release blockers, and validation tasks.',
        triggerType: 'cron',
        cronExpression: '0 16 * * 2,4',
        timezone: 'UTC',
      },
    ],
    ownershipPatterns: [
      {
        target: 'goal',
        relationship: 'manager',
        description: 'Manage release-readiness goals and coordinate pre/post-release tasks.',
      },
      {
        target: 'forge_scope',
        relationship: 'watcher',
        description: 'Watch release and CI scopes for recurring regressions.',
      },
    ],
    toolPermissions: {},
  },
  {
    key: 'security-auditor.default',
    handle: 'security-auditor',
    displayName: 'Security Auditor',
    description:
      'Monitors code, dependencies, permissions, and operational changes for security risk.',
    instructions:
      'Audit security-relevant changes. Watch dependency, auth, permission, networking, storage, and secret-handling changes. Produce evidence-backed findings, recommend scoped mitigations, and escalate high-risk issues before release.',
    suggestedAutonomyLevel: 1,
    suggestedEventSubscriptions: [
      {
        source: 'github',
        topic: 'pull_request.opened',
        filter: { paths: ['**/auth/**', '**/security/**', '**/storage/**', 'bun.lock'] },
      },
      {
        source: 'github',
        topic: 'dependabot.alert.*',
        filter: { severities: ['high', 'critical'] },
      },
    ],
    reminderDefaults: [
      {
        title: 'Review security posture',
        body: 'Review dependency alerts, auth changes, permission changes, and unresolved security findings.',
        triggerType: 'cron',
        cronExpression: '0 11 * * 3',
        timezone: 'UTC',
      },
    ],
    ownershipPatterns: [
      {
        target: 'goal',
        relationship: 'watcher',
        description: 'Watch security-sensitive goals and request tasks when risk appears.',
      },
      {
        target: 'forge_scope',
        relationship: 'manager',
        description: 'Manage Forge scopes for security lessons, risky patterns, and mitigations.',
      },
    ],
    toolPermissions: {},
  },
  {
    key: 'marketing.default',
    handle: 'marketing',
    displayName: 'Marketing',
    description:
      'Turns product progress and customer signals into positioning, content ideas, and launch assets.',
    instructions:
      'Maintain marketing momentum. Track shipped capabilities, user pain points, customer language, launch timing, and content opportunities. Draft concise positioning, campaign ideas, and asset tasks while coordinating with product and release owners.',
    suggestedAutonomyLevel: 2,
    suggestedEventSubscriptions: [
      {
        source: 'github',
        topic: 'release.published',
        filter: {},
      },
      {
        source: 'space',
        topic: 'goal.done',
        filter: { labels: ['launch', 'marketing', 'customer'] },
      },
    ],
    reminderDefaults: [
      {
        title: 'Review marketing opportunities',
        body: 'Review shipped features, upcoming releases, customer signals, and content follow-ups.',
        triggerType: 'cron',
        cronExpression: '0 15 * * 1',
        timezone: 'UTC',
      },
    ],
    ownershipPatterns: [
      {
        target: 'goal',
        relationship: 'manager',
        description: 'Manage launch, content, and positioning goals.',
      },
      {
        target: 'forge_scope',
        relationship: 'watcher',
        description: 'Watch customer-language and product-learning scopes for messaging inputs.',
      },
    ],
    toolPermissions: {},
  },
  {
    key: 'sales.default',
    handle: 'sales',
    displayName: 'Sales',
    description:
      'Tracks pipeline follow-ups, account context, objections, and product asks from prospects.',
    instructions:
      'Support sales execution. Track prospect follow-ups, account context, objections, feature asks, and handoffs. Prepare next-step reminders, summarize buying signals, and convert repeated objections or product gaps into actionable tasks.',
    suggestedAutonomyLevel: 2,
    suggestedEventSubscriptions: [
      {
        source: 'crm',
        topic: 'deal.*',
        filter: { stages: ['qualified', 'proposal', 'at_risk'] },
      },
      {
        source: 'calendar',
        topic: 'meeting.ended',
        filter: { tags: ['sales', 'customer'] },
      },
    ],
    reminderDefaults: [
      {
        title: 'Review sales follow-ups',
        body: 'Review open deals, overdue follow-ups, customer asks, and next-step commitments.',
        triggerType: 'cron',
        cronExpression: '0 9 * * 1-5',
        timezone: 'UTC',
      },
    ],
    ownershipPatterns: [
      {
        target: 'goal',
        relationship: 'manager',
        description: 'Manage pipeline, account, and follow-up goals.',
      },
      {
        target: 'forge_scope',
        relationship: 'watcher',
        description: 'Watch customer objections and product-request scopes for trends.',
      },
    ],
    toolPermissions: {},
  },
  {
    key: 'research.default',
    handle: 'research',
    displayName: 'Research',
    description:
      'Deep-dives topics, synthesizes sources, and delivers structured findings with evidence.',
    instructions:
      'Conduct thorough research. Search broadly, synthesize sources critically, surface contradictions, and deliver structured findings with citations. Prefer depth over speed, flag uncertainty explicitly, and create tasks for follow-up investigation when needed.',
    suggestedAutonomyLevel: 2,
    suggestedEventSubscriptions: [
      {
        source: 'space',
        topic: 'task.created',
        filter: { labels: ['research', 'investigate', 'analysis'] },
      },
    ],
    reminderDefaults: [
      {
        title: 'Weekly research digest',
        body: 'Summarize open research threads and surface any findings that need human review.',
        triggerType: 'cron' as const,
        cronExpression: '0 9 * * 1',
        timezone: 'UTC',
      },
    ],
    ownershipPatterns: [
      {
        target: 'goal',
        relationship: 'owner',
        description: 'Own research goals and maintain structured findings summaries.',
      },
      {
        target: 'forge_scope',
        relationship: 'watcher',
        description: 'Watch knowledge scopes for gaps and outdated findings.',
      },
    ],
    toolPermissions: {},
  },
  {
    key: 'family-ops-chores.default',
    handle: 'family-ops-chores',
    displayName: 'Family Ops/Chores',
    description:
      'Coordinates household routines, chores, appointments, errands, and recurring family logistics.',
    instructions:
      'Coordinate household operations. Track chores, errands, appointments, recurring maintenance, family commitments, and reminders. Keep plans practical, assign clear owners when known, escalate time-sensitive conflicts, and avoid making commitments without human confirmation.',
    suggestedAutonomyLevel: 1,
    suggestedEventSubscriptions: [
      {
        source: 'calendar',
        topic: 'event.*',
        filter: { calendars: ['family', 'home'] },
      },
      {
        source: 'tasks',
        topic: 'task.overdue',
        filter: { lists: ['chores', 'errands', 'home'] },
      },
    ],
    reminderDefaults: [
      {
        title: 'Review household plan',
        body: 'Review chores, errands, appointments, maintenance reminders, and unresolved family logistics.',
        triggerType: 'cron',
        cronExpression: '0 18 * * 0',
        timezone: 'UTC',
      },
    ],
    ownershipPatterns: [
      {
        target: 'goal',
        relationship: 'manager',
        description: 'Manage recurring home, chores, errands, and family logistics goals.',
      },
      {
        target: 'forge_scope',
        relationship: 'watcher',
        description: 'Watch household-routine scopes for recurring friction and missed reminders.',
      },
    ],
    toolPermissions: {},
  },
];

export function getLongHorizonAgentTemplates(): SpaceLongHorizonAgentTemplate[] {
  return structuredClone(LONG_HORIZON_AGENT_TEMPLATES);
}

export function getLongHorizonAgentTemplate(
  key: string
): SpaceLongHorizonAgentTemplate | undefined {
  return getLongHorizonAgentTemplates().find((template) => template.key === key);
}
