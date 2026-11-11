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
import mdNeoSystemPackCheck from './neo/system/pack-check.md' with { type: 'text' };
import mdNeoSystemHumanWork from './neo/system/human-work.md' with { type: 'text' };
import mdNeoSystemDriverHealth from './neo/system/driver-health.md' with { type: 'text' };
import mdDriversWorkerProvenanceExactId from './drivers/worker-provenance-exact-id.md' with {
  type: 'text',
};
import mdDriversWorkerProvenanceTeamField from './drivers/worker-provenance-team-field.md' with {
  type: 'text',
};
import mdDriversWorkerProvenanceOpenPrs from './drivers/worker-provenance-open-prs.md' with {
  type: 'text',
};
import mdneoSessionTrack from './neo/session-track.md' with { type: 'text' };
import mdneoSystemFocusedDiscussion from './neo/system/focused-discussion.md' with { type: 'text' };
import mdneoSystemGoalCycle from './neo/system/goal-cycle.md' with { type: 'text' };
import mdneoSystemQuickAck from './neo/system/quick-ack.md' with { type: 'text' };
import mdneoSystemQuickAckListening from './neo/system/quick-ack-listening.md' with {
  type: 'text',
};
import mdneoSystemRoot from './neo/system/root.md' with { type: 'text' };
import mdNeoFront from './neo/front.md' with { type: 'text' };
export const NEO_FRONT = mdNeoFront;
import mdneoSystemPackPreferences from './neo/system/pack-preferences.md' with { type: 'text' };
import mdneoSystemStandingRules from './neo/system/standing-rules.md' with { type: 'text' };
import mdneoSystemRootTurnEnd from './neo/system/root-turn-end.md' with { type: 'text' };
import mdneoPacksCodingSkill from './neo/packs/coding/SKILL.md' with { type: 'text' };
import mdneoPacksCodingWorkerWorktreeBrief from './neo/packs/coding/worker-worktree-brief.md' with {
  type: 'text',
};
import mdneoPacksCodingWorkerRules from './neo/packs/coding/worker-rules.md' with { type: 'text' };
import mdneoWorkFiles from './neo/work/files.md' with { type: 'text' };
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
import mdneoPacksDelegationInstructions from './neo/packs/delegation/instructions.md' with {
  type: 'text',
};
import mdneoWorkGoalRemaining from './neo/work/goal-remaining.md' with { type: 'text' };
import mdneoWorkBlocker from './neo/work/blocker.md' with { type: 'text' };
import mdneoWorkPreferenceChanged from './neo/work/preference-changed.md' with { type: 'text' };

export { fillPrompt } from './loader.ts';
import { parseSkillMarkdown, type SkillMarkdown } from './loader.ts';

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
import mddriversClaudeRcToggleRequest from './drivers/claude-rc-toggle-request.md' with {
  type: 'text',
};
import mdmailboxDeliveryFailed from './mailbox/delivery-failed.md' with { type: 'text' };
import mdmessagingReplyProtocol from './messaging/reply-protocol.md' with { type: 'text' };
import mdmessagingReplyToTarget from './messaging/reply-to-target.md' with { type: 'text' };
import mdmessagingReplyToTask from './messaging/reply-to-task.md' with { type: 'text' };
import mdspaceOperationsDoorListing from './space/operations-door-listing.md' with { type: 'text' };
import mdToolOpen from './neo/tools/neo.open.md' with { type: 'text' };
import mdToolRestart from './neo/tools/neo.restart.md' with { type: 'text' };
import mdToolRuleSave from './neo/tools/neo.rule.save.md' with { type: 'text' };
import mdToolSessionLink from './neo/tools/neo.session.link.md' with { type: 'text' };
import mdToolSessionMute from './neo/tools/neo.session.mute.md' with { type: 'text' };
import mdToolSessionTrack from './neo/tools/neo.session.track.md' with { type: 'text' };
import mdToolPackRead from './neo/tools/neo.pack.read.md' with { type: 'text' };
import mdToolAskHistory from './neo/tools/neo.ask.history.md' with { type: 'text' };
import mdToolSnapshot from './neo/tools/neo.snapshot.md' with { type: 'text' };
import mdToolProjectSave from './neo/tools/neo.project.save.md' with { type: 'text' };
import mdToolAskDoneTodos from './neo/tools/neo.ask.doneTodos.md' with { type: 'text' };
import mdToolAskRead from './neo/tools/neo.ask.read.md' with { type: 'text' };
import mdToolAskOpen from './neo/tools/neo.ask.open.md' with { type: 'text' };
import mdToolAskOutcome from './neo/tools/neo.ask.outcome.md' with { type: 'text' };
import mdToolAskTopic from './neo/tools/neo.ask.topic.md' with { type: 'text' };
import mdToolAskSettle from './neo/tools/neo.ask.settle.md' with { type: 'text' };
import mdToolConversationAsksRead from './neo/tools/neo.conversation.asks.read.md' with {
  type: 'text',
};
import mdToolConversationImageRead from './neo/tools/neo.conversation.image.read.md' with {
  type: 'text',
};
import mdToolQuestionAnswer from './neo/tools/neo.question.answer.md' with { type: 'text' };
import mdToolQuestionAsk from './neo/tools/neo.question.ask.md' with { type: 'text' };
import mdToolQuestionGet from './neo/tools/neo.question.get.md' with { type: 'text' };
import mdToolQuestionRelay from './neo/tools/neo.question.relay.md' with { type: 'text' };
import mdToolQuestionResolve from './neo/tools/neo.question.resolve.md' with { type: 'text' };
import mdToolQuestionRetire from './neo/tools/neo.question.retire.md' with { type: 'text' };
import mdToolRuleApplyAnswer from './neo/tools/neo.rule.applyAnswer.md' with { type: 'text' };
import mdToolRuleAsk from './neo/tools/neo.rule.ask.md' with { type: 'text' };
import mdToolTodoAdd from './neo/tools/neo.todo.add.md' with { type: 'text' };
import mdToolTodoBind from './neo/tools/neo.todo.bind.md' with { type: 'text' };
import mdToolTodoClose from './neo/tools/neo.todo.close.md' with { type: 'text' };
import mdToolTodoContinue from './neo/tools/neo.todo.continue.md' with { type: 'text' };
import mdToolTodoEdit from './neo/tools/neo.todo.edit.md' with { type: 'text' };
import mdToolTodoHold from './neo/tools/neo.todo.hold.md' with { type: 'text' };
import mdToolTodoProceed from './neo/tools/neo.todo.proceed.md' with { type: 'text' };
import mdToolTodoRemove from './neo/tools/neo.todo.remove.md' with { type: 'text' };
import mdToolTodoRetry from './neo/tools/neo.todo.retry.md' with { type: 'text' };
import mdToolPackPreferencesApplyAnswer from './neo/tools/pack.preferences.applyAnswer.md' with {
  type: 'text',
};
import mdToolPackPreferencesAsk from './neo/tools/pack.preferences.ask.md' with { type: 'text' };
import mdToolPackPreferencesGet from './neo/tools/pack.preferences.get.md' with { type: 'text' };
import mdToolPackPreferencesList from './neo/tools/pack.preferences.list.md' with { type: 'text' };
import mdToolPackPreferencesSet from './neo/tools/pack.preferences.set.md' with { type: 'text' };
import mdToolAskSearch from './neo/tools/neo.ask.search.md' with { type: 'text' };
import mdToolCodingAssign from './neo/tools/neo.coding.assign.md' with { type: 'text' };
import mdToolCodingMergeHuman from './neo/tools/neo.coding.merge.human.md' with { type: 'text' };
import mdToolCodingMergePrepare from './neo/tools/neo.coding.merge.prepare.md' with {
  type: 'text',
};
import mdToolCodingMergeRetry from './neo/tools/neo.coding.merge.retry.md' with { type: 'text' };
import mdToolCodingPrFile from './neo/tools/neo.coding.pr.file.md' with { type: 'text' };
import mdToolCodingResult from './neo/tools/neo.coding.result.md' with { type: 'text' };
import mdToolCodingSmoke from './neo/tools/neo.coding.smoke.md' with { type: 'text' };
import mdToolCodingWritePlan from './neo/tools/neo.coding.write.plan.md' with { type: 'text' };
import mdToolConversationRead from './neo/tools/neo.conversation.read.md' with { type: 'text' };
import mdToolDraftRecover from './neo/tools/neo.draft.recover.md' with { type: 'text' };
import mdToolHomeGithub from './neo/tools/neo.home.github.md' with { type: 'text' };
import mdToolHomeInit from './neo/tools/neo.home.init.md' with { type: 'text' };
import mdToolHomeRead from './neo/tools/neo.home.read.md' with { type: 'text' };
import mdToolHomeSave from './neo/tools/neo.home.save.md' with { type: 'text' };
import mdToolMessageSend from './neo/tools/neo.message.send.md' with { type: 'text' };
import mdToolPeerAccept from './neo/tools/neo.peer.accept.md' with { type: 'text' };
import mdToolPeerInvite from './neo/tools/neo.peer.invite.md' with { type: 'text' };
import mdToolPeerList from './neo/tools/neo.peer.list.md' with { type: 'text' };
import mdToolPeerRemove from './neo/tools/neo.peer.remove.md' with { type: 'text' };
import mdToolPeerSend from './neo/tools/neo.peer.send.md' with { type: 'text' };
import mdToolPreferencesSet from './neo/tools/neo.preferences.set.md' with { type: 'text' };
import mdToolProjectForget from './neo/tools/neo.project.forget.md' with { type: 'text' };
import mdToolProjectMove from './neo/tools/neo.project.move.md' with { type: 'text' };
import mdToolProjectSection from './neo/tools/neo.project.section.md' with { type: 'text' };
import mdToolProjectsReorganize from './neo/tools/neo.projects.reorganize.md' with { type: 'text' };
import mdToolPublicationEdit from './neo/tools/neo.publication.edit.md' with { type: 'text' };
import mdToolPublicationPublish from './neo/tools/neo.publication.publish.md' with { type: 'text' };
import mdToolPublicationRead from './neo/tools/neo.publication.read.md' with { type: 'text' };
import mdToolSessionArchive from './neo/tools/neo.session.archive.md' with { type: 'text' };
import mdToolSpeechAck from './neo/tools/neo.speech.ack.md' with { type: 'text' };
import mdToolSpeechCatalog from './neo/tools/neo.speech.catalog.md' with { type: 'text' };
import mdToolSpeechListen from './neo/tools/neo.speech.listen.md' with { type: 'text' };
import mdToolSpeechPreview from './neo/tools/neo.speech.preview.md' with { type: 'text' };
import mdToolSpeechSay from './neo/tools/neo.speech.say.md' with { type: 'text' };
import mdToolQuestionRelayAnswer from './neo/tools/neo.question.relayAnswer.md' with {
  type: 'text',
};
import mdToolRelaySendersSet from './neo/tools/neo.relaySenders.set.md' with { type: 'text' };
import mdToolRelaySendersRecent from './neo/tools/neo.relaySenders.recent.md' with { type: 'text' };
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
  'neo/system/pack-check.md': mdNeoSystemPackCheck,
  'neo/system/human-work.md': mdNeoSystemHumanWork,
  'neo/system/driver-health.md': mdNeoSystemDriverHealth,
  'drivers/worker-provenance-exact-id.md': mdDriversWorkerProvenanceExactId,
  'drivers/worker-provenance-team-field.md': mdDriversWorkerProvenanceTeamField,
  'drivers/worker-provenance-open-prs.md': mdDriversWorkerProvenanceOpenPrs,
  'neo/system/focused-discussion.md': mdneoSystemFocusedDiscussion,
  'neo/system/goal-cycle.md': mdneoSystemGoalCycle,
  'neo/system/quick-ack.md': mdneoSystemQuickAck,
  'neo/system/quick-ack-listening.md': mdneoSystemQuickAckListening,
  'neo/system/root.md': mdneoSystemRoot,
  'neo/system/root-turn-end.md': mdneoSystemRootTurnEnd,
  'neo/system/pack-preferences.md': mdneoSystemPackPreferences,
  'neo/system/standing-rules.md': mdneoSystemStandingRules,
  'neo/work/goal-asked.md': mdneoWorkGoalAsked,
  'neo/work/goal-done-when.md': mdneoWorkGoalDoneWhen,
  'neo/packs/coding/worker-worktree-brief.md': mdneoPacksCodingWorkerWorktreeBrief,
  'neo/packs/coding/worker-rules.md': mdneoPacksCodingWorkerRules,
  'neo/packs/coding/goal-merge.md': mdneoWorkGoalMerge,
  'neo/packs/coding/goal-pr-events.md': mdneoPacksCodingGoalPrEvents,
  'neo/packs/coding/goal-pr-subscribe.md': mdneoPacksCodingGoalPrSubscribe,
  'neo/packs/life-admin/instructions.md': mdneoPacksLifeAdminInstructions,
  'neo/packs/delegation/instructions.md': mdneoPacksDelegationInstructions,
  'neo/work/goal-remaining.md': mdneoWorkGoalRemaining,
  'neo/work/files.md': mdneoWorkFiles,
  'neo/work/goal.md': mdneoWorkGoal,
  'neo/work/blocker.md': mdneoWorkBlocker,
  'neo/work/preference-changed.md': mdneoWorkPreferenceChanged,
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
  NEO_PACK_CODING_WORKER_RULES,
  NEO_PACK_CODING_WORKTREE_BRIEF,
  NEO_PACK_LIFE_ADMIN_INSTRUCTIONS,
  NEO_PACK_DELEGATION_INSTRUCTIONS,
  NEO_SESSION_TRACK,
  NEO_GOAL_CYCLE,
  NEO_QUICK_ACK,
  NEO_QUICK_ACK_LISTENING,
  NEO_FOCUSED_DISCUSSION,
  NEO_PACK_CHECK,
  NEO_HUMAN_WORK,
  NEO_DRIVER_HEALTH,
  WORKER_PROVENANCE_EXACT_ID,
  WORKER_PROVENANCE_TEAM_FIELD,
  WORKER_PROVENANCE_OPEN_PRS,
  NEO_ROOT_PROMPT,
  NEO_ROOT_TURN_END,
  NEO_STANDING_RULES,
  NEO_PACK_PREFERENCES,
  NEO_WORK_GOAL_ASKED,
  NEO_WORK_GOAL_DONE_WHEN,
  NEO_WORK_GOAL_MERGE,
  NEO_WORK_GOAL_PR_EVENTS,
  NEO_WORK_GOAL_PR_SUBSCRIBE,
  NEO_WORK_GOAL_REMAINING,
  NEO_WORK_GOAL,
  NEO_WORK_BLOCKER,
  NEO_PREFERENCE_CHANGED,
  NEO_NON_CODING_FILES,
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

const codingSkill = parseSkillMarkdown(mdneoPacksCodingSkill, 'neo/packs/coding/SKILL.md');

export const NEO_PACK_CODING_INSTRUCTIONS = codingSkill.body;

export const NEO_PACK_SKILLS: Readonly<
  Record<string, SkillMarkdown & { files: Readonly<Record<string, string>> }>
> = {
  [codingSkill.name]: { ...codingSkill, files: { 'SKILL.md': mdneoPacksCodingSkill } },
};

export const NEO_TOOL_DESCRIPTIONS: Readonly<Record<string, string>> = Object.freeze(
  buildPromptRegistry({
    'neo/tools/neo.open.md': mdToolOpen,
    'neo/tools/neo.restart.md': mdToolRestart,
    'neo/tools/neo.rule.save.md': mdToolRuleSave,
    'neo/tools/neo.session.link.md': mdToolSessionLink,
    'neo/tools/neo.session.mute.md': mdToolSessionMute,
    'neo/tools/neo.session.track.md': mdToolSessionTrack,
    'neo/tools/neo.pack.read.md': mdToolPackRead,
    'neo/tools/neo.ask.history.md': mdToolAskHistory,
    'neo/tools/neo.snapshot.md': mdToolSnapshot,
    'neo/tools/neo.project.save.md': mdToolProjectSave,
    'neo/tools/neo.ask.doneTodos.md': mdToolAskDoneTodos,
    'neo/tools/neo.ask.read.md': mdToolAskRead,
    'neo/tools/neo.ask.open.md': mdToolAskOpen,
    'neo/tools/neo.ask.outcome.md': mdToolAskOutcome,
    'neo/tools/neo.ask.topic.md': mdToolAskTopic,
    'neo/tools/neo.ask.settle.md': mdToolAskSettle,
    'neo/tools/neo.conversation.asks.read.md': mdToolConversationAsksRead,
    'neo/tools/neo.conversation.image.read.md': mdToolConversationImageRead,
    'neo/tools/neo.question.answer.md': mdToolQuestionAnswer,
    'neo/tools/neo.question.ask.md': mdToolQuestionAsk,
    'neo/tools/neo.question.get.md': mdToolQuestionGet,
    'neo/tools/neo.question.relay.md': mdToolQuestionRelay,
    'neo/tools/neo.question.resolve.md': mdToolQuestionResolve,
    'neo/tools/neo.question.retire.md': mdToolQuestionRetire,
    'neo/tools/neo.rule.applyAnswer.md': mdToolRuleApplyAnswer,
    'neo/tools/neo.rule.ask.md': mdToolRuleAsk,
    'neo/tools/neo.todo.add.md': mdToolTodoAdd,
    'neo/tools/neo.todo.bind.md': mdToolTodoBind,
    'neo/tools/neo.todo.close.md': mdToolTodoClose,
    'neo/tools/neo.todo.continue.md': mdToolTodoContinue,
    'neo/tools/neo.todo.edit.md': mdToolTodoEdit,
    'neo/tools/neo.todo.hold.md': mdToolTodoHold,
    'neo/tools/neo.todo.proceed.md': mdToolTodoProceed,
    'neo/tools/neo.todo.remove.md': mdToolTodoRemove,
    'neo/tools/neo.todo.retry.md': mdToolTodoRetry,
    'neo/tools/pack.preferences.applyAnswer.md': mdToolPackPreferencesApplyAnswer,
    'neo/tools/pack.preferences.ask.md': mdToolPackPreferencesAsk,
    'neo/tools/pack.preferences.get.md': mdToolPackPreferencesGet,
    'neo/tools/pack.preferences.list.md': mdToolPackPreferencesList,
    'neo/tools/pack.preferences.set.md': mdToolPackPreferencesSet,
    'neo/tools/neo.ask.search.md': mdToolAskSearch,
    'neo/tools/neo.coding.assign.md': mdToolCodingAssign,
    'neo/tools/neo.coding.merge.human.md': mdToolCodingMergeHuman,
    'neo/tools/neo.coding.merge.prepare.md': mdToolCodingMergePrepare,
    'neo/tools/neo.coding.merge.retry.md': mdToolCodingMergeRetry,
    'neo/tools/neo.coding.pr.file.md': mdToolCodingPrFile,
    'neo/tools/neo.coding.result.md': mdToolCodingResult,
    'neo/tools/neo.coding.smoke.md': mdToolCodingSmoke,
    'neo/tools/neo.coding.write.plan.md': mdToolCodingWritePlan,
    'neo/tools/neo.conversation.read.md': mdToolConversationRead,
    'neo/tools/neo.draft.recover.md': mdToolDraftRecover,
    'neo/tools/neo.home.github.md': mdToolHomeGithub,
    'neo/tools/neo.home.init.md': mdToolHomeInit,
    'neo/tools/neo.home.read.md': mdToolHomeRead,
    'neo/tools/neo.home.save.md': mdToolHomeSave,
    'neo/tools/neo.message.send.md': mdToolMessageSend,
    'neo/tools/neo.peer.accept.md': mdToolPeerAccept,
    'neo/tools/neo.peer.invite.md': mdToolPeerInvite,
    'neo/tools/neo.peer.list.md': mdToolPeerList,
    'neo/tools/neo.peer.remove.md': mdToolPeerRemove,
    'neo/tools/neo.peer.send.md': mdToolPeerSend,
    'neo/tools/neo.preferences.set.md': mdToolPreferencesSet,
    'neo/tools/neo.project.forget.md': mdToolProjectForget,
    'neo/tools/neo.project.move.md': mdToolProjectMove,
    'neo/tools/neo.project.section.md': mdToolProjectSection,
    'neo/tools/neo.projects.reorganize.md': mdToolProjectsReorganize,
    'neo/tools/neo.publication.edit.md': mdToolPublicationEdit,
    'neo/tools/neo.publication.publish.md': mdToolPublicationPublish,
    'neo/tools/neo.publication.read.md': mdToolPublicationRead,
    'neo/tools/neo.session.archive.md': mdToolSessionArchive,
    'neo/tools/neo.speech.ack.md': mdToolSpeechAck,
    'neo/tools/neo.speech.catalog.md': mdToolSpeechCatalog,
    'neo/tools/neo.speech.listen.md': mdToolSpeechListen,
    'neo/tools/neo.speech.preview.md': mdToolSpeechPreview,
    'neo/tools/neo.speech.say.md': mdToolSpeechSay,
    'neo/tools/neo.question.relayAnswer.md': mdToolQuestionRelayAnswer,
    'neo/tools/neo.relaySenders.set.md': mdToolRelaySendersSet,
    'neo/tools/neo.relaySenders.recent.md': mdToolRelaySendersRecent,
  })
);

export function neoToolDescription(name: string): string {
  if (!Object.hasOwn(NEO_TOOL_DESCRIPTIONS, name)) {
    throw new Error(`Missing Neo tool description: ${name}`);
  }
  return NEO_TOOL_DESCRIPTIONS[name];
}
