/// <reference path="./markdown.d.ts" />

import mdagentsLongHorizonOwnerReviewContract from './agents/long-horizon/owner-review-contract.md' with {
  type: 'text',
};
import mdagentsLongHorizonSpaceManager from './agents/long-horizon/space-manager.md' with {
  type: 'text',
};
import mdagentsLongHorizonTaskManager from './agents/long-horizon/task-manager.md' with {
  type: 'text',
};
import mdagentsLongHorizonSchedulingGuardrail from './agents/long-horizon-scheduling-guardrail.md' with {
  type: 'text',
};
import mdagentsNonDelegatingGeneral from './agents/non-delegating-general.md' with { type: 'text' };
import mdagentsPresetsCoder from './agents/presets/coder.md' with { type: 'text' };
import mdagentsPresetsGeneral from './agents/presets/general.md' with { type: 'text' };
import mdagentsPresetsLegacyReviewer from './agents/presets/legacy-reviewer.md' with {
  type: 'text',
};
import mdagentsPresetsPlanner from './agents/presets/planner.md' with { type: 'text' };
import mdagentsPresetsResearch from './agents/presets/research.md' with { type: 'text' };
import mdagentsSystemContractsQaSystemContract from './agents/system-contracts/qa-system-contract.md' with {
  type: 'text',
};
import mdagentsSystemContractsReviewerSystemContract from './agents/system-contracts/reviewer-system-contract.md' with {
  type: 'text',
};
import mdcommandsMergeSession from './commands/merge-session.md' with { type: 'text' };
import mdcoordinatorCoder from './coordinator/coder.md' with { type: 'text' };
import mdcoordinatorCoordinator from './coordinator/coordinator.md' with { type: 'text' };
import mdcoordinatorDebugger from './coordinator/debugger.md' with { type: 'text' };
import mdcoordinatorReviewer from './coordinator/reviewer.md' with { type: 'text' };
import mdcoordinatorTester from './coordinator/tester.md' with { type: 'text' };
import mdcoordinatorVcs from './coordinator/vcs.md' with { type: 'text' };
import mdcoordinatorVerifier from './coordinator/verifier.md' with { type: 'text' };
import mdgithubRouterSystemPrompt from './github/router-system-prompt.md' with { type: 'text' };
import mdgithubSecuritySystemPrompt from './github/security-system-prompt.md' with { type: 'text' };
import mdneoSessionTrack from './neo/session-track.md' with { type: 'text' };
import mdneoSystemGoalCycle from './neo/system/goal-cycle.md' with { type: 'text' };
import mdneoSystemRoot from './neo/system/root.md' with { type: 'text' };
import mdneoSystemRootTurnEnd from './neo/system/root-turn-end.md' with { type: 'text' };
import mdneoPacksCodingInstructions from './neo/packs/coding/instructions.md' with { type: 'text' };
import mdneoPacksCodingWorkerRules from './neo/packs/coding/worker-rules.md' with { type: 'text' };
import mdneoWorkGoal from './neo/work/goal.md' with { type: 'text' };
import mdneoWorkGoalAsked from './neo/work/goal-asked.md' with { type: 'text' };
import mdneoWorkGoalDoneWhen from './neo/work/goal-done-when.md' with { type: 'text' };
import mdneoWorkGoalMerge from './neo/packs/coding/goal-merge.md' with { type: 'text' };
import mdneoPacksCodingGoalPrEvents from './neo/packs/coding/goal-pr-events.md' with {
  type: 'text',
};
import mdneoPacksCodingGoalPrSubscribe from './neo/packs/coding/goal-pr-subscribe.md' with {
  type: 'text',
};
import mdneoPacksLifeAdminInstructions from './neo/packs/life-admin/instructions.md' with {
  type: 'text',
};
import mdneoWorkGoalRemaining from './neo/work/goal-remaining.md' with { type: 'text' };
import mdneoWorkBlocker from './neo/work/blocker.md' with { type: 'text' };

export { fillPrompt } from './loader.ts';

import mdagentsDefaultInstructions from './agents/default-instructions.md' with { type: 'text' };
import mdevolutionEpisodeJudge from './evolution/episode-judge.md' with { type: 'text' };
import mdprovidersCodexProbeInstructions from './providers/codex-probe-instructions.md' with {
  type: 'text',
};
import mdsessionCloneBrief from './session/clone-brief.md' with { type: 'text' };
import mdspaceScopeBriefing from './space/scope/briefing.md' with { type: 'text' };
import mdspaceScopeRoleAgent from './space/scope/role-agent.md' with { type: 'text' };
import mdspaceScopeRoleDirectWorker from './space/scope/role-direct-worker.md' with {
  type: 'text',
};
import mdspaceScopeRoleNamedAgent from './space/scope/role-named-agent.md' with { type: 'text' };
import mdspaceScopeRoleWorkflowWorker from './space/scope/role-workflow-worker.md' with {
  type: 'text',
};
import mdspaceScopeStandingInstructions from './space/scope/standing-instructions.md' with {
  type: 'text',
};
import mdworkflowsSelectionPrompt from './workflows/selection-prompt.md' with { type: 'text' };
import mdagentLimitErrorClassifier from './agent/limit-error-classifier.md' with { type: 'text' };
import mdevolutionConversationFriction from './evolution/conversation-friction.md' with {
  type: 'text',
};
import mdsessionMinimalWorktree from './session/minimal-worktree.md' with { type: 'text' };
import mdsessionWorktreeIsolation from './session/worktree-isolation.md' with { type: 'text' };
import mdspaceContractBlocker from './space/contract/blocker.md' with { type: 'text' };
import mdspaceContractCompleteHuman from './space/contract/complete-human.md' with { type: 'text' };
import mdspaceContractCompleteUnlocked from './space/contract/complete-unlocked.md' with {
  type: 'text',
};
import mdspaceContractEndNodeOverride from './space/contract/end-node-override.md' with {
  type: 'text',
};
import mdspaceContractNodeHeader from './space/contract/node-header.md' with { type: 'text' };
import mdspaceContractToolCatalog from './space/contract/tool-catalog.md' with { type: 'text' };
import mdspaceContractToolDoor from './space/contract/tool-door.md' with { type: 'text' };
import mdspaceContractToolSuggested from './space/contract/tool-suggested.md' with { type: 'text' };
import mdspaceContractWorkerHeader from './space/contract/worker-header.md' with { type: 'text' };
import mdspaceRuntimeHandoffNoTranscript from './space/runtime/handoff-no-transcript.md' with {
  type: 'text',
};
import mdspaceRuntimeHandoffNote from './space/runtime/handoff-note.md' with { type: 'text' };
import mdspaceRuntimeHandoffTranscript from './space/runtime/handoff-transcript.md' with {
  type: 'text',
};
import mdspaceRuntimeIdleNudge from './space/runtime/idle-nudge.md' with { type: 'text' };
import mdspaceRuntimeRestartHandoffLost from './space/runtime/restart-handoff-lost.md' with {
  type: 'text',
};
import mdspaceRuntimeRestartNodeEnded from './space/runtime/restart-node-ended.md' with {
  type: 'text',
};
import mdspaceRuntimeRestartNotice from './space/runtime/restart-notice.md' with { type: 'text' };
import mdspaceRuntimeStallNag from './space/runtime/stall-nag.md' with { type: 'text' };
import mdspaceRuntimeTerminalError from './space/runtime/terminal-error.md' with { type: 'text' };
import mdspaceTaskMessageGatedHandoff from './space/task-message/gated-handoff.md' with {
  type: 'text',
};
import mdspaceTaskMessageGoalOutcome from './space/task-message/goal-outcome.md' with {
  type: 'text',
};
import mdspaceTaskMessageVerificationLabel from './space/task-message/verification-label.md' with {
  type: 'text',
};
import mdagentBashLoopRecovery from './agent/bash-loop-recovery.md' with { type: 'text' };
import mdagentLoopRecovery from './agent/loop-recovery.md' with { type: 'text' };
import mdagentQuestionCancelled from './agent/question-cancelled.md' with { type: 'text' };
import mdagentRepeatedToolError from './agent/repeated-tool-error.md' with { type: 'text' };
import mdagentTaskNotificationContinue from './agent/task-notification-continue.md' with {
  type: 'text',
};
import mdagentsInactivityNag from './agents/inactivity-nag.md' with { type: 'text' };
import mdgoalsOutcomeReady from './goals/outcome-ready.md' with { type: 'text' };
import mddriversClaudeDesktopRelay from './drivers/claude-desktop-relay.md' with { type: 'text' };
import mddriversCodexWorker from './drivers/codex-worker.md' with { type: 'text' };
import mddriversClaudeDesktopPrepare from './drivers/claude-desktop-prepare.md' with {
  type: 'text',
};
import mddriversClaudeDesktopWakeBrief from './drivers/claude-desktop-wake-brief.md' with {
  type: 'text',
};
import mddriversClaudeDesktopWakeRequest from './drivers/claude-desktop-wake-request.md' with {
  type: 'text',
};
import mddriversClaudeRcToggleBrief from './drivers/claude-rc-toggle-brief.md' with {
  type: 'text',
};
import mddriversClaudeRcToggleRequest from './drivers/claude-rc-toggle-request.md' with {
  type: 'text',
};
import mdmailboxDeliveryFailed from './mailbox/delivery-failed.md' with { type: 'text' };
import mdmessagingReplyProtocol from './messaging/reply-protocol.md' with { type: 'text' };
import mdmessagingReplyToTarget from './messaging/reply-to-target.md' with { type: 'text' };
import mdmessagingReplyToTask from './messaging/reply-to-task.md' with { type: 'text' };
import mdspaceOperationsDoorListing from './space/operations-door-listing.md' with { type: 'text' };
import { buildPromptRegistry } from './loader.ts';
import mdruntimePostApprovalCompletion from './runtime/post-approval-completion.md' with {
  type: 'text',
};
import mdruntimePromptTooLongContinueNag from './runtime/prompt-too-long-continue-nag.md' with {
  type: 'text',
};
import mdruntimeWorkflowSelectorInstructions from './runtime/workflow-selector-instructions.md' with {
  type: 'text',
};
import mdsessionTitleGeneration from './session/title-generation.md' with { type: 'text' };
import mdspaceAgentMemory from './space/agent-memory.md' with { type: 'text' };
import mdspaceDbQuery from './space/db-query.md' with { type: 'text' };
import mdspaceOperationsDoor from './space/operations-door.md' with { type: 'text' };
import mdworkflowsCoderOnlyMergeInstructions from './workflows/coder-only/merge-instructions.md' with {
  type: 'text',
};
import mdworkflowsCoderOnlyPrompt from './workflows/coder-only/prompt.md' with { type: 'text' };
import mdworkflowsCoderOwnedExternalGate from './workflows/coder-owned/external-gate.md' with {
  type: 'text',
};
import mdworkflowsCoderOwnedMergeInstructions from './workflows/coder-owned/merge-instructions.md' with {
  type: 'text',
};
import mdworkflowsCoderOwnedMergePrompt from './workflows/coder-owned/merge-prompt.md' with {
  type: 'text',
};
import mdworkflowsCoderOwnedQaPrompt from './workflows/coder-owned/qa-prompt.md' with {
  type: 'text',
};
import mdworkflowsCoderOwnedQaReviewPrompt from './workflows/coder-owned/qa-review-prompt.md' with {
  type: 'text',
};
import mdworkflowsCoderOwnedReviewPrompt from './workflows/coder-owned/review-prompt.md' with {
  type: 'text',
};
import mdworkflowsGuidanceCallActionPreference from './workflows/guidance/call-action-preference.md' with {
  type: 'text',
};
import mdworkflowsGuidanceCodexReactionApproval from './workflows/guidance/codex-reaction-approval.md' with {
  type: 'text',
};
import mdworkflowsGuidanceExternalReviewBots from './workflows/guidance/external-review-bots.md' with {
  type: 'text',
};
import mdworkflowsGuidanceFullstackCodingNochange from './workflows/guidance/fullstack-coding-nochange.md' with {
  type: 'text',
};
import mdworkflowsGuidanceFullstackQaPostApproval from './workflows/guidance/fullstack-qa-post-approval.md' with {
  type: 'text',
};
import mdworkflowsGuidanceRetiredCallActionPreferencePreOperationNames from './workflows/guidance/retired/call-action-preference-pre-operation-names.md' with {
  type: 'text',
};
import mdworkflowsGuidanceRetiredCallActionPreferencePreTaskApprove from './workflows/guidance/retired/call-action-preference-pre-task-approve.md' with {
  type: 'text',
};
import mdworkflowsGuidanceRetiredExternalReviewBotsPreCheckSeeding from './workflows/guidance/retired/external-review-bots-pre-check-seeding.md' with {
  type: 'text',
};
import mdworkflowsGuidanceRetiredExternalReviewBotsPreTypename from './workflows/guidance/retired/external-review-bots-pre-typename.md' with {
  type: 'text',
};
import mdworkflowsGuidanceReviewPolicy from './workflows/guidance/review-policy.md' with {
  type: 'text',
};
import mdworkflowsGuidanceReviewThreadApprovalCheck from './workflows/guidance/review-thread-approval-check.md' with {
  type: 'text',
};
import mdworkflowsGuidanceReviewThreadResolution from './workflows/guidance/review-thread-resolution.md' with {
  type: 'text',
};
import mdworkflowsGuidanceReviewerPostApprovalBlocker from './workflows/guidance/reviewer-post-approval-blocker.md' with {
  type: 'text',
};
import mdworkflowsGuidanceReviewerZeroFindingsGate from './workflows/guidance/reviewer-zero-findings-gate.md' with {
  type: 'text',
};
import mdworkflowsGuidanceSubscribePrEvents from './workflows/guidance/subscribe-pr-events.md' with {
  type: 'text',
};
import mdworkflowsResearchResearchPrompt from './workflows/research/research-prompt.md' with {
  type: 'text',
};
import mdworkflowsResearchReviewPrompt from './workflows/research/review-prompt.md' with {
  type: 'text',
};
import mdworkflowsReviewOnlyReviewPrompt from './workflows/review-only/review-prompt.md' with {
  type: 'text',
};

const registry: Record<string, string> = {
  'agents/long-horizon-scheduling-guardrail.md': mdagentsLongHorizonSchedulingGuardrail,
  'agents/long-horizon/owner-review-contract.md': mdagentsLongHorizonOwnerReviewContract,
  'agents/long-horizon/space-manager.md': mdagentsLongHorizonSpaceManager,
  'agents/long-horizon/task-manager.md': mdagentsLongHorizonTaskManager,
  'agents/non-delegating-general.md': mdagentsNonDelegatingGeneral,
  'agents/presets/coder.md': mdagentsPresetsCoder,
  'agents/presets/general.md': mdagentsPresetsGeneral,
  'agents/presets/legacy-reviewer.md': mdagentsPresetsLegacyReviewer,
  'agents/presets/planner.md': mdagentsPresetsPlanner,
  'agents/presets/research.md': mdagentsPresetsResearch,
  'agents/system-contracts/qa-system-contract.md': mdagentsSystemContractsQaSystemContract,
  'agents/system-contracts/reviewer-system-contract.md':
    mdagentsSystemContractsReviewerSystemContract,
  'commands/merge-session.md': mdcommandsMergeSession,
  'coordinator/coder.md': mdcoordinatorCoder,
  'coordinator/coordinator.md': mdcoordinatorCoordinator,
  'coordinator/debugger.md': mdcoordinatorDebugger,
  'coordinator/reviewer.md': mdcoordinatorReviewer,
  'coordinator/tester.md': mdcoordinatorTester,
  'coordinator/vcs.md': mdcoordinatorVcs,
  'coordinator/verifier.md': mdcoordinatorVerifier,
  'github/router-system-prompt.md': mdgithubRouterSystemPrompt,
  'github/security-system-prompt.md': mdgithubSecuritySystemPrompt,
  'neo/session-track.md': mdneoSessionTrack,
  'neo/system/goal-cycle.md': mdneoSystemGoalCycle,
  'neo/system/root.md': mdneoSystemRoot,
  'neo/system/root-turn-end.md': mdneoSystemRootTurnEnd,
  'neo/work/goal-asked.md': mdneoWorkGoalAsked,
  'neo/work/goal-done-when.md': mdneoWorkGoalDoneWhen,
  'neo/packs/coding/instructions.md': mdneoPacksCodingInstructions,
  'neo/packs/coding/worker-rules.md': mdneoPacksCodingWorkerRules,
  'neo/packs/coding/goal-merge.md': mdneoWorkGoalMerge,
  'neo/packs/coding/goal-pr-events.md': mdneoPacksCodingGoalPrEvents,
  'neo/packs/coding/goal-pr-subscribe.md': mdneoPacksCodingGoalPrSubscribe,
  'neo/packs/life-admin/instructions.md': mdneoPacksLifeAdminInstructions,
  'neo/work/goal-remaining.md': mdneoWorkGoalRemaining,
  'neo/work/goal.md': mdneoWorkGoal,
  'neo/work/blocker.md': mdneoWorkBlocker,
  'agents/default-instructions.md': mdagentsDefaultInstructions,
  'evolution/episode-judge.md': mdevolutionEpisodeJudge,
  'providers/codex-probe-instructions.md': mdprovidersCodexProbeInstructions,
  'session/clone-brief.md': mdsessionCloneBrief,
  'space/scope/briefing.md': mdspaceScopeBriefing,
  'space/scope/role-agent.md': mdspaceScopeRoleAgent,
  'space/scope/role-direct-worker.md': mdspaceScopeRoleDirectWorker,
  'space/scope/role-named-agent.md': mdspaceScopeRoleNamedAgent,
  'space/scope/role-workflow-worker.md': mdspaceScopeRoleWorkflowWorker,
  'space/scope/standing-instructions.md': mdspaceScopeStandingInstructions,
  'workflows/selection-prompt.md': mdworkflowsSelectionPrompt,
  'agent/limit-error-classifier.md': mdagentLimitErrorClassifier,
  'evolution/conversation-friction.md': mdevolutionConversationFriction,
  'session/minimal-worktree.md': mdsessionMinimalWorktree,
  'session/worktree-isolation.md': mdsessionWorktreeIsolation,
  'space/contract/blocker.md': mdspaceContractBlocker,
  'space/contract/complete-human.md': mdspaceContractCompleteHuman,
  'space/contract/complete-unlocked.md': mdspaceContractCompleteUnlocked,
  'space/contract/end-node-override.md': mdspaceContractEndNodeOverride,
  'space/contract/node-header.md': mdspaceContractNodeHeader,
  'space/contract/tool-catalog.md': mdspaceContractToolCatalog,
  'space/contract/tool-door.md': mdspaceContractToolDoor,
  'space/contract/tool-suggested.md': mdspaceContractToolSuggested,
  'space/contract/worker-header.md': mdspaceContractWorkerHeader,
  'space/runtime/handoff-no-transcript.md': mdspaceRuntimeHandoffNoTranscript,
  'space/runtime/handoff-note.md': mdspaceRuntimeHandoffNote,
  'space/runtime/handoff-transcript.md': mdspaceRuntimeHandoffTranscript,
  'space/runtime/idle-nudge.md': mdspaceRuntimeIdleNudge,
  'space/runtime/restart-handoff-lost.md': mdspaceRuntimeRestartHandoffLost,
  'space/runtime/restart-node-ended.md': mdspaceRuntimeRestartNodeEnded,
  'space/runtime/restart-notice.md': mdspaceRuntimeRestartNotice,
  'space/runtime/stall-nag.md': mdspaceRuntimeStallNag,
  'space/runtime/terminal-error.md': mdspaceRuntimeTerminalError,
  'space/task-message/gated-handoff.md': mdspaceTaskMessageGatedHandoff,
  'space/task-message/goal-outcome.md': mdspaceTaskMessageGoalOutcome,
  'space/task-message/verification-label.md': mdspaceTaskMessageVerificationLabel,
  'agent/bash-loop-recovery.md': mdagentBashLoopRecovery,
  'agent/loop-recovery.md': mdagentLoopRecovery,
  'agent/question-cancelled.md': mdagentQuestionCancelled,
  'agent/repeated-tool-error.md': mdagentRepeatedToolError,
  'agent/task-notification-continue.md': mdagentTaskNotificationContinue,
  'agents/inactivity-nag.md': mdagentsInactivityNag,
  'goals/outcome-ready.md': mdgoalsOutcomeReady,
  'drivers/claude-desktop-relay.md': mddriversClaudeDesktopRelay,
  'drivers/codex-worker.md': mddriversCodexWorker,
  'drivers/claude-desktop-prepare.md': mddriversClaudeDesktopPrepare,
  'drivers/claude-desktop-wake-brief.md': mddriversClaudeDesktopWakeBrief,
  'drivers/claude-desktop-wake-request.md': mddriversClaudeDesktopWakeRequest,
  'drivers/claude-rc-toggle-brief.md': mddriversClaudeRcToggleBrief,
  'drivers/claude-rc-toggle-request.md': mddriversClaudeRcToggleRequest,
  'mailbox/delivery-failed.md': mdmailboxDeliveryFailed,
  'messaging/reply-protocol.md': mdmessagingReplyProtocol,
  'messaging/reply-to-target.md': mdmessagingReplyToTarget,
  'messaging/reply-to-task.md': mdmessagingReplyToTask,
  'space/operations-door-listing.md': mdspaceOperationsDoorListing,
  'runtime/post-approval-completion.md': mdruntimePostApprovalCompletion,
  'runtime/prompt-too-long-continue-nag.md': mdruntimePromptTooLongContinueNag,
  'runtime/workflow-selector-instructions.md': mdruntimeWorkflowSelectorInstructions,
  'session/title-generation.md': mdsessionTitleGeneration,
  'space/agent-memory.md': mdspaceAgentMemory,
  'space/db-query.md': mdspaceDbQuery,
  'space/operations-door.md': mdspaceOperationsDoor,
  'workflows/coder-only/merge-instructions.md': mdworkflowsCoderOnlyMergeInstructions,
  'workflows/coder-only/prompt.md': mdworkflowsCoderOnlyPrompt,
  'workflows/coder-owned/external-gate.md': mdworkflowsCoderOwnedExternalGate,
  'workflows/coder-owned/merge-instructions.md': mdworkflowsCoderOwnedMergeInstructions,
  'workflows/coder-owned/merge-prompt.md': mdworkflowsCoderOwnedMergePrompt,
  'workflows/coder-owned/qa-prompt.md': mdworkflowsCoderOwnedQaPrompt,
  'workflows/coder-owned/qa-review-prompt.md': mdworkflowsCoderOwnedQaReviewPrompt,
  'workflows/coder-owned/review-prompt.md': mdworkflowsCoderOwnedReviewPrompt,
  'workflows/guidance/call-action-preference.md': mdworkflowsGuidanceCallActionPreference,
  'workflows/guidance/codex-reaction-approval.md': mdworkflowsGuidanceCodexReactionApproval,
  'workflows/guidance/external-review-bots.md': mdworkflowsGuidanceExternalReviewBots,
  'workflows/guidance/retired/call-action-preference-pre-operation-names.md':
    mdworkflowsGuidanceRetiredCallActionPreferencePreOperationNames,
  'workflows/guidance/retired/call-action-preference-pre-task-approve.md':
    mdworkflowsGuidanceRetiredCallActionPreferencePreTaskApprove,
  'workflows/guidance/retired/external-review-bots-pre-check-seeding.md':
    mdworkflowsGuidanceRetiredExternalReviewBotsPreCheckSeeding,
  'workflows/guidance/retired/external-review-bots-pre-typename.md':
    mdworkflowsGuidanceRetiredExternalReviewBotsPreTypename,
  'workflows/guidance/fullstack-coding-nochange.md': mdworkflowsGuidanceFullstackCodingNochange,
  'workflows/guidance/fullstack-qa-post-approval.md': mdworkflowsGuidanceFullstackQaPostApproval,
  'workflows/guidance/review-policy.md': mdworkflowsGuidanceReviewPolicy,
  'workflows/guidance/review-thread-approval-check.md':
    mdworkflowsGuidanceReviewThreadApprovalCheck,
  'workflows/guidance/review-thread-resolution.md': mdworkflowsGuidanceReviewThreadResolution,
  'workflows/guidance/reviewer-post-approval-blocker.md':
    mdworkflowsGuidanceReviewerPostApprovalBlocker,
  'workflows/guidance/reviewer-zero-findings-gate.md': mdworkflowsGuidanceReviewerZeroFindingsGate,
  'workflows/guidance/subscribe-pr-events.md': mdworkflowsGuidanceSubscribePrEvents,
  'workflows/research/research-prompt.md': mdworkflowsResearchResearchPrompt,
  'workflows/research/review-prompt.md': mdworkflowsResearchReviewPrompt,
  'workflows/review-only/review-prompt.md': mdworkflowsReviewOnlyReviewPrompt,
};

export const {
  LONG_HORIZON_SCHEDULING_GUARDRAIL,
  LONG_HORIZON_OWNER_REVIEW_CONTRACT,
  LH_SPACE_MANAGER_INSTRUCTIONS,
  LH_TASK_MANAGER_INSTRUCTIONS,
  NON_DELEGATING_GENERAL_PROMPT,
  PRESET_CODER_PROMPT,
  PRESET_GENERAL_PROMPT,
  LEGACY_REVIEWER_PROMPT,
  PRESET_PLANNER_PROMPT,
  PRESET_RESEARCH_PROMPT,
  QA_SYSTEM_CONTRACT,
  REVIEWER_SYSTEM_CONTRACT,
  MERGE_SESSION_COMMAND_PROMPT,
  SUBAGENT_CODER_PROMPT,
  COORDINATOR_PROMPT,
  SUBAGENT_DEBUGGER_PROMPT,
  SUBAGENT_REVIEWER_PROMPT,
  SUBAGENT_TESTER_PROMPT,
  SUBAGENT_VCS_PROMPT,
  SUBAGENT_VERIFIER_PROMPT,
  GITHUB_ROUTER_SYSTEM_PROMPT,
  GITHUB_SECURITY_SYSTEM_PROMPT,
  NEO_PACK_CODING_INSTRUCTIONS,
  NEO_PACK_CODING_WORKER_RULES,
  NEO_PACK_LIFE_ADMIN_INSTRUCTIONS,
  NEO_SESSION_TRACK,
  NEO_GOAL_CYCLE,
  NEO_ROOT_PROMPT,
  NEO_ROOT_TURN_END,
  NEO_WORK_GOAL_ASKED,
  NEO_WORK_GOAL_DONE_WHEN,
  NEO_WORK_GOAL_MERGE,
  NEO_WORK_GOAL_PR_EVENTS,
  NEO_WORK_GOAL_PR_SUBSCRIBE,
  NEO_WORK_GOAL_REMAINING,
  NEO_WORK_GOAL,
  NEO_WORK_BLOCKER,
  AGENT_DEFAULT_INSTRUCTIONS,
  EVOLUTION_EPISODE_JUDGE_PROMPT,
  CODEX_PROBE_INSTRUCTIONS,
  SESSION_CLONE_BRIEF,
  SPACE_SCOPE_BRIEFING,
  SPACE_SCOPE_ROLE_AGENT,
  SPACE_SCOPE_ROLE_DIRECT_WORKER,
  SPACE_SCOPE_ROLE_NAMED_AGENT,
  SPACE_SCOPE_ROLE_WORKFLOW_WORKER,
  SPACE_SCOPE_STANDING_INSTRUCTIONS,
  WORKFLOW_SELECTION_PROMPT,
  LIMIT_ERROR_CLASSIFIER_PROMPT,
  EVOLUTION_CONVERSATION_FRICTION_PROMPT,
  MINIMAL_WORKTREE_PROMPT,
  WORKTREE_ISOLATION_PROMPT,
  SPACE_CONTRACT_BLOCKER,
  SPACE_CONTRACT_COMPLETE_HUMAN,
  SPACE_CONTRACT_COMPLETE_UNLOCKED,
  SPACE_CONTRACT_END_NODE_OVERRIDE,
  SPACE_CONTRACT_NODE_HEADER,
  SPACE_CONTRACT_TOOL_CATALOG,
  SPACE_CONTRACT_TOOL_DOOR,
  SPACE_CONTRACT_TOOL_SUGGESTED,
  SPACE_CONTRACT_WORKER_HEADER,
  SPACE_RUNTIME_HANDOFF_NO_TRANSCRIPT,
  SPACE_RUNTIME_HANDOFF_NOTE,
  SPACE_RUNTIME_HANDOFF_TRANSCRIPT,
  SPACE_RUNTIME_IDLE_NUDGE,
  SPACE_RUNTIME_RESTART_HANDOFF_LOST,
  SPACE_RUNTIME_RESTART_NODE_ENDED,
  SPACE_RUNTIME_RESTART_NOTICE,
  SPACE_RUNTIME_STALL_NAG,
  SPACE_RUNTIME_TERMINAL_ERROR,
  TASK_MESSAGE_GATED_HANDOFF,
  TASK_MESSAGE_GOAL_OUTCOME,
  TASK_MESSAGE_VERIFICATION_LABEL,
  AGENT_BASH_LOOP_RECOVERY,
  AGENT_LOOP_RECOVERY,
  AGENT_QUESTION_CANCELLED,
  AGENT_REPEATED_TOOL_ERROR,
  AGENT_TASK_NOTIFICATION_CONTINUE,
  AGENT_INACTIVITY_NAG,
  GOAL_OUTCOME_READY,
  CLAUDE_DESKTOP_RELAY,
  CODEX_WORKER_INSTRUCTIONS,
  CLAUDE_DESKTOP_PREPARE,
  CLAUDE_DESKTOP_WAKE_BRIEF,
  CLAUDE_DESKTOP_WAKE_REQUEST,
  CLAUDE_RC_TOGGLE_BRIEF,
  CLAUDE_RC_TOGGLE_REQUEST,
  MAILBOX_DELIVERY_FAILED,
  MESSAGING_REPLY_PROTOCOL,
  MESSAGING_REPLY_TO_TARGET,
  MESSAGING_REPLY_TO_TASK,
  SPACE_OPERATIONS_DOOR_LISTING,
  POST_APPROVAL_COMPLETION_INSTRUCTIONS,
  PROMPT_TOO_LONG_CONTINUE_NAG,
  WORKFLOW_SELECTOR_INSTRUCTIONS,
  TITLE_GENERATION_PROMPT,
  SPACE_AGENT_MEMORY_BRIEFING,
  SPACE_DB_QUERY_BRIEFING,
  SPACE_OPERATIONS_DOOR,
  CODER_ONLY_MERGE_INSTRUCTIONS,
  CODER_ONLY_PROMPT,
  CODER_EXTERNAL_GATE_BLOCK,
  CODER_OWNED_MERGE_INSTRUCTIONS,
  CODER_OWNED_MERGE_PROMPT,
  CODER_OWNED_QA_PROMPT,
  CODER_OWNED_QA_REVIEW_PROMPT,
  CODER_OWNED_REVIEW_PROMPT,
  CALL_ACTION_PREFERENCE_GUIDANCE,
  CALL_ACTION_PREFERENCE_GUIDANCE_PRE_OPERATION_NAMES,
  CALL_ACTION_PREFERENCE_GUIDANCE_PRE_TASK_APPROVE,
  CODEX_REACTION_APPROVAL_GUIDANCE,
  EXTERNAL_REVIEW_BOTS_GUIDANCE,
  EXTERNAL_REVIEW_BOTS_GUIDANCE_PRE_CHECK_SEEDING,
  EXTERNAL_REVIEW_BOTS_GUIDANCE_PRE_TYPENAME,
  FULLSTACK_CODING_NOCHANGE_GUIDANCE,
  FULLSTACK_QA_POST_APPROVAL_PARAGRAPH,
  REVIEW_POLICY_GUIDANCE,
  REVIEW_THREAD_APPROVAL_CHECK_GUIDANCE,
  REVIEW_THREAD_RESOLUTION_GUIDANCE,
  REVIEWER_POST_APPROVAL_BLOCKER_PARAGRAPH,
  REVIEWER_ZERO_FINDINGS_GATE,
  CODER_OWNED_PR_SUBSCRIBE_GUIDANCE,
  RESEARCH_PROMPT,
  RESEARCH_REVIEW_PROMPT,
  REVIEW_ONLY_REVIEW_PROMPT,
} = buildPromptRegistry(registry);
