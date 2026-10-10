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
import mdneoCatchUp from './neo/catch-up.md' with { type: 'text' };
import mdneoConsultationReceiptClosed from './neo/consultation/receipt-closed.md' with {
  type: 'text',
};
import mdneoConsultationReceiptPending from './neo/consultation/receipt-pending.md' with {
  type: 'text',
};
import mdneoConsultationReceiptReturned from './neo/consultation/receipt-returned.md' with {
  type: 'text',
};
import mdneoConsultationRequest from './neo/consultation/request.md' with { type: 'text' };
import mdneoConsultationSettled from './neo/consultation/settled.md' with { type: 'text' };
import mdneoConsultationSettledExpired from './neo/consultation/settled-expired.md' with {
  type: 'text',
};
import mdneoConsultationSettledFailed from './neo/consultation/settled-failed.md' with {
  type: 'text',
};
import mdneoConsultationSettledReported from './neo/consultation/settled-reported.md' with {
  type: 'text',
};
import mdneoConsultationSettledStopped from './neo/consultation/settled-stopped.md' with {
  type: 'text',
};
import mdneoPublishNudge from './neo/publish-nudge.md' with { type: 'text' };
import mdneoRecentConversation from './neo/recent-conversation.md' with { type: 'text' };
import mdneoRouteClassifier from './neo/route-classifier.md' with { type: 'text' };
import mdneoSystemHolderConsultationReturn from './neo/system/holder-consultation-return.md' with {
  type: 'text',
};
import mdneoSystemHolderOperations from './neo/system/holder-operations.md' with { type: 'text' };
import mdneoSystemHolderRole from './neo/system/holder-role.md' with { type: 'text' };
import mdneoSystemHolderSnapshotScope from './neo/system/holder-snapshot-scope.md' with {
  type: 'text',
};
import mdneoSystemPrompt from './neo/system/prompt.md' with { type: 'text' };
import mdneoSystemRootClarify from './neo/system/root-clarify.md' with { type: 'text' };
import mdneoSystemRootConsultationReturn from './neo/system/root-consultation-return.md' with {
  type: 'text',
};
import mdneoSystemRootOperations from './neo/system/root-operations.md' with { type: 'text' };
import mdneoSystemRootRole from './neo/system/root-role.md' with { type: 'text' };
import mdneoSystemRootRuleSave from './neo/system/root-rule-save.md' with { type: 'text' };
import mdneoSystemRootSnapshotScope from './neo/system/root-snapshot-scope.md' with {
  type: 'text',
};
import mdneoWorkDelegated from './neo/work/delegated.md' with { type: 'text' };
import mdneoWorkDoneCheck from './neo/work/done-check.md' with { type: 'text' };
import mdneoWorkDoneCheckAskForeign from './neo/work/done-check-ask-foreign.md' with {
  type: 'text',
};
import mdneoWorkDoneCheckAskNext from './neo/work/done-check-ask-next.md' with { type: 'text' };
import mdneoWorkDoneCheckAskOwned from './neo/work/done-check-ask-owned.md' with { type: 'text' };
import mdneoWorkDoneCheckBudget from './neo/work/done-check-budget.md' with { type: 'text' };
import mdneoWorkDoneCheckContinue from './neo/work/done-check-continue.md' with { type: 'text' };
import mdneoWorkDoneCheckPrsLive from './neo/work/done-check-prs-live.md' with { type: 'text' };
import mdneoWorkDoneCheckPrsReady from './neo/work/done-check-prs-ready.md' with { type: 'text' };
import mdneoWorkDoneCheckPrsStale from './neo/work/done-check-prs-stale.md' with { type: 'text' };
import mdneoWorkGoal from './neo/work/goal.md' with { type: 'text' };
import mdneoWorkGoalAsked from './neo/work/goal-asked.md' with { type: 'text' };
import mdneoWorkGoalDoneWhen from './neo/work/goal-done-when.md' with { type: 'text' };
import mdneoWorkGoalMerge from './neo/work/goal-merge.md' with { type: 'text' };
import mdneoWorkGoalRemaining from './neo/work/goal-remaining.md' with { type: 'text' };
import mdneoWorkNeedsYou from './neo/work/needs-you.md' with { type: 'text' };
import mdneoWorkReturnReview from './neo/work/return-review.md' with { type: 'text' };
import mdneoWorkReturned from './neo/work/returned.md' with { type: 'text' };
import mdneoWorkReturnedRetried from './neo/work/returned-retried.md' with { type: 'text' };
import mdneoWorkReturnedRetry from './neo/work/returned-retry.md' with { type: 'text' };
import mdneoWorkStall from './neo/work/stall.md' with { type: 'text' };
import mdneoWorkStallBudget from './neo/work/stall-budget.md' with { type: 'text' };
import mdneoWorkStallCheck from './neo/work/stall-check.md' with { type: 'text' };
import mdneoWorkStuck from './neo/work/stuck.md' with { type: 'text' };
import mdneoWorkStuckAbandoned from './neo/work/stuck-abandoned.md' with { type: 'text' };
import mdneoWorkStuckBudget from './neo/work/stuck-budget.md' with { type: 'text' };
import mdneoWorkStuckCheck from './neo/work/stuck-check.md' with { type: 'text' };
import mdneoWorkSummary from './neo/work/summary.md' with { type: 'text' };

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
import mdagentCompactionResume from './agent/compaction-resume.md' with { type: 'text' };
import mdagentLoopRecovery from './agent/loop-recovery.md' with { type: 'text' };
import mdagentQuestionCancelled from './agent/question-cancelled.md' with { type: 'text' };
import mdagentRepeatedToolError from './agent/repeated-tool-error.md' with { type: 'text' };
import mdagentTaskNotificationContinue from './agent/task-notification-continue.md' with {
  type: 'text',
};
import mdagentsInactivityNag from './agents/inactivity-nag.md' with { type: 'text' };
import mdgoalsOutcomeReady from './goals/outcome-ready.md' with { type: 'text' };
import mddriversClaudeDesktopOpening from './drivers/claude-desktop-opening.md' with {
  type: 'text',
};
import mddriversClaudeDesktopRelay from './drivers/claude-desktop-relay.md' with { type: 'text' };
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
import mdneoCapabilities from './neo/capabilities.md' with { type: 'text' };
import mdneoResponseFocus from './neo/response-focus.md' with { type: 'text' };
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
  'neo/capabilities.md': mdneoCapabilities,
  'neo/response-focus.md': mdneoResponseFocus,
  'neo/catch-up.md': mdneoCatchUp,
  'neo/consultation/receipt-closed.md': mdneoConsultationReceiptClosed,
  'neo/consultation/receipt-pending.md': mdneoConsultationReceiptPending,
  'neo/consultation/receipt-returned.md': mdneoConsultationReceiptReturned,
  'neo/consultation/request.md': mdneoConsultationRequest,
  'neo/consultation/settled-expired.md': mdneoConsultationSettledExpired,
  'neo/consultation/settled-failed.md': mdneoConsultationSettledFailed,
  'neo/consultation/settled-reported.md': mdneoConsultationSettledReported,
  'neo/consultation/settled-stopped.md': mdneoConsultationSettledStopped,
  'neo/consultation/settled.md': mdneoConsultationSettled,
  'neo/publish-nudge.md': mdneoPublishNudge,
  'neo/recent-conversation.md': mdneoRecentConversation,
  'neo/route-classifier.md': mdneoRouteClassifier,
  'neo/system/holder-consultation-return.md': mdneoSystemHolderConsultationReturn,
  'neo/system/holder-operations.md': mdneoSystemHolderOperations,
  'neo/system/holder-role.md': mdneoSystemHolderRole,
  'neo/system/holder-snapshot-scope.md': mdneoSystemHolderSnapshotScope,
  'neo/system/prompt.md': mdneoSystemPrompt,
  'neo/system/root-clarify.md': mdneoSystemRootClarify,
  'neo/system/root-consultation-return.md': mdneoSystemRootConsultationReturn,
  'neo/system/root-operations.md': mdneoSystemRootOperations,
  'neo/system/root-role.md': mdneoSystemRootRole,
  'neo/system/root-rule-save.md': mdneoSystemRootRuleSave,
  'neo/system/root-snapshot-scope.md': mdneoSystemRootSnapshotScope,
  'neo/work/delegated.md': mdneoWorkDelegated,
  'neo/work/done-check-ask-foreign.md': mdneoWorkDoneCheckAskForeign,
  'neo/work/done-check-ask-next.md': mdneoWorkDoneCheckAskNext,
  'neo/work/done-check-ask-owned.md': mdneoWorkDoneCheckAskOwned,
  'neo/work/done-check-budget.md': mdneoWorkDoneCheckBudget,
  'neo/work/done-check-continue.md': mdneoWorkDoneCheckContinue,
  'neo/work/done-check-prs-live.md': mdneoWorkDoneCheckPrsLive,
  'neo/work/done-check-prs-ready.md': mdneoWorkDoneCheckPrsReady,
  'neo/work/done-check-prs-stale.md': mdneoWorkDoneCheckPrsStale,
  'neo/work/done-check.md': mdneoWorkDoneCheck,
  'neo/work/goal-asked.md': mdneoWorkGoalAsked,
  'neo/work/goal-done-when.md': mdneoWorkGoalDoneWhen,
  'neo/work/goal-merge.md': mdneoWorkGoalMerge,
  'neo/work/goal-remaining.md': mdneoWorkGoalRemaining,
  'neo/work/goal.md': mdneoWorkGoal,
  'neo/work/needs-you.md': mdneoWorkNeedsYou,
  'neo/work/return-review.md': mdneoWorkReturnReview,
  'neo/work/returned-retried.md': mdneoWorkReturnedRetried,
  'neo/work/returned-retry.md': mdneoWorkReturnedRetry,
  'neo/work/returned.md': mdneoWorkReturned,
  'neo/work/stall-budget.md': mdneoWorkStallBudget,
  'neo/work/stall-check.md': mdneoWorkStallCheck,
  'neo/work/stall.md': mdneoWorkStall,
  'neo/work/stuck-abandoned.md': mdneoWorkStuckAbandoned,
  'neo/work/stuck-budget.md': mdneoWorkStuckBudget,
  'neo/work/stuck-check.md': mdneoWorkStuckCheck,
  'neo/work/stuck.md': mdneoWorkStuck,
  'neo/work/summary.md': mdneoWorkSummary,
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
  'agent/compaction-resume.md': mdagentCompactionResume,
  'agent/loop-recovery.md': mdagentLoopRecovery,
  'agent/question-cancelled.md': mdagentQuestionCancelled,
  'agent/repeated-tool-error.md': mdagentRepeatedToolError,
  'agent/task-notification-continue.md': mdagentTaskNotificationContinue,
  'agents/inactivity-nag.md': mdagentsInactivityNag,
  'goals/outcome-ready.md': mdgoalsOutcomeReady,
  'drivers/claude-desktop-opening.md': mddriversClaudeDesktopOpening,
  'drivers/claude-desktop-relay.md': mddriversClaudeDesktopRelay,
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
  NEO_CAPABILITIES_BRIEFING,
  NEO_RESPONSE_FOCUS_BRIEFING,
  NEO_CATCH_UP_HEADER,
  NEO_CONSULTATION_RECEIPT_CLOSED,
  NEO_CONSULTATION_RECEIPT_PENDING,
  NEO_CONSULTATION_RECEIPT_RETURNED,
  NEO_CONSULTATION_REQUEST,
  NEO_CONSULTATION_SETTLED_EXPIRED,
  NEO_CONSULTATION_SETTLED_FAILED,
  NEO_CONSULTATION_SETTLED_REPORTED,
  NEO_CONSULTATION_SETTLED_STOPPED,
  NEO_CONSULTATION_SETTLED,
  NEO_PUBLISH_NUDGE,
  NEO_RECENT_CONVERSATION_HEADER,
  NEO_ROUTE_PROMPT,
  NEO_HOLDER_CONSULTATION_RETURN,
  NEO_HOLDER_OPERATIONS,
  NEO_HOLDER_ROLE,
  NEO_HOLDER_SNAPSHOT_SCOPE,
  NEO_SYSTEM_PROMPT,
  NEO_ROOT_CLARIFY,
  NEO_ROOT_CONSULTATION_RETURN,
  NEO_ROOT_OPERATIONS,
  NEO_ROOT_ROLE,
  NEO_ROOT_RULE_SAVE,
  NEO_ROOT_SNAPSHOT_SCOPE,
  NEO_WORK_DELEGATED,
  NEO_WORK_DONE_CHECK_ASK_FOREIGN,
  NEO_WORK_DONE_CHECK_ASK_NEXT,
  NEO_WORK_DONE_CHECK_ASK_OWNED,
  NEO_WORK_DONE_CHECK_BUDGET,
  NEO_WORK_DONE_CHECK_CONTINUE,
  NEO_WORK_DONE_CHECK_PRS_LIVE,
  NEO_WORK_DONE_CHECK_PRS_READY,
  NEO_WORK_DONE_CHECK_PRS_STALE,
  NEO_WORK_DONE_CHECK,
  NEO_WORK_GOAL_ASKED,
  NEO_WORK_GOAL_DONE_WHEN,
  NEO_WORK_GOAL_MERGE,
  NEO_WORK_GOAL_REMAINING,
  NEO_WORK_GOAL,
  NEO_WORK_NEEDS_YOU,
  NEO_WORK_RETURN_REVIEW,
  NEO_WORK_RETURNED_RETRIED,
  NEO_WORK_RETURNED_RETRY,
  NEO_WORK_RETURNED,
  NEO_WORK_STALL_BUDGET,
  NEO_WORK_STALL_CHECK,
  NEO_WORK_STALL,
  NEO_WORK_STUCK_ABANDONED,
  NEO_WORK_STUCK_BUDGET,
  NEO_WORK_STUCK_CHECK,
  NEO_WORK_STUCK,
  NEO_WORK_SUMMARY_NOTE,
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
  AGENT_COMPACTION_RESUME,
  AGENT_LOOP_RECOVERY,
  AGENT_QUESTION_CANCELLED,
  AGENT_REPEATED_TOOL_ERROR,
  AGENT_TASK_NOTIFICATION_CONTINUE,
  AGENT_INACTIVITY_NAG,
  GOAL_OUTCOME_READY,
  CLAUDE_DESKTOP_OPENING,
  CLAUDE_DESKTOP_RELAY,
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
