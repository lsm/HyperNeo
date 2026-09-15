import { createHash } from 'node:crypto';
import { CODER_OWNED_MERGE_PROMPT } from '@hyperneo/prompts';
import type { DeclarativeToolGuard, SpaceWorkflow, WorkflowNode } from '@hyperneo/shared';
import { CODING_WITH_QA_WORKFLOW, CODING_WORKFLOW } from './built-in-coding-workflows.ts';
import { RESEARCH_WORKFLOW } from './built-in-research-workflows.ts';
import { CODER_OWNED_MERGE_INSTRUCTIONS } from './post-approval-merge-template.ts';

export const RETIRED_POST_APPROVAL_NODE = 'Post-Approval';
export const RETIRED_MERGER_SLOT_NAMES = new Set(['merger']);
export const RETIRED_MERGE_INSTRUCTIONS_SHA256 =
  '635b45c887a11bd6fcbebf05c5ab8670386532661b54bec25e2815b3854f90ad';
export const RETIRED_MERGER_RAW_MERGE_GUARD: DeclarativeToolGuard = {
  matcher: 'Bash',
  pattern: 'gh\\b[^\\n]*?pr\\s+merge\\b|\\bmergePullRequest\\b|pulls\\/[^\\/\\s"]+\\/merge\\b',
  decision: 'deny',
  reason:
    'Direct PR merges are blocked — use the merge_pr tool instead. merge_pr is the authoritative, audited merge ' +
    'path: it deterministically verifies the approval covers the current head (plus CI, unresolved review ' +
    'threads, and branch protection) before merging bound to that head. This Bash guard is defense-in-depth ' +
    '(it blocks the common/direct raw-merge forms, including wrapped ones); it is not the enforcement — always ' +
    'merge through merge_pr.',
};
export const RETIRED_PR_MERGER_SLOT_PROMPT =
  'You are the PR Merger — the designated shell-capable agent for post-approval merges. ' +
  'You are spawned only after the task is approved; your first message is the exact merge ' +
  'procedure — follow it step by step. You hold the only Bash tool in this review/merge split ' +
  '(the approval authority posts reviews via post_review and runs no code). You merge the PR ' +
  'ONLY through the `merge_pr` tool — a deterministic gate that verifies the current head is ' +
  'covered by a real GitHub approval (plus CI, unresolved threads, branch protection) before ' +
  'merging bound to that head. Raw `gh pr merge` and merge-API calls are BLOCKED on this slot; ' +
  'do not attempt them. The Space task approval (approval_source) is provenance only and does ' +
  'NOT authorize a merge — never reason that it should let a merge through. Clean up the ' +
  'branch, sync the worktree, and report any merge blocker (including conflicts) to the ' +
  'approval authority — wait for it to re-approve the head and signal you to continue. The ' +
  'approval authority and channel target are named in your first message and the Runtime ' +
  'Execution Contract; they differ by workflow (e.g. Review for some, QA for others), so never ' +
  'assume a specific one. You never approve — the approval authority is the re-approval ' +
  'authority. Do NOT call approve_task or submit_for_approval — the task is already approved. ' +
  'Call mark_complete once the merge and sync are done.';

export function stripRetiredPostApproval({
  templateName,
  nodes,
  channels,
  hooks,
}: {
  templateName: string;
  nodes: WorkflowNode[];
  channels: SpaceWorkflow['channels'];
  hooks: SpaceWorkflow['hooks'];
}): {
  nodes: WorkflowNode[];
  channels: SpaceWorkflow['channels'];
  hooks: SpaceWorkflow['hooks'];
  channelsChanged: boolean;
} {
  const isStableCoderOwnedTemplate = new Set([
    CODING_WORKFLOW.name,
    CODING_WITH_QA_WORKFLOW.name,
    RESEARCH_WORKFLOW.name,
  ]).has(templateName);
  if (!isStableCoderOwnedTemplate) {
    return { nodes, channels, hooks, channelsChanged: false };
  }

  const isPristineMergerNode = (node: WorkflowNode): boolean => {
    if (node.name !== RETIRED_POST_APPROVAL_NODE) return false;
    if (node.postApproval?.targetAgent !== 'merger') return false;
    const hasRetiredRoute =
      typeof node.postApproval.instructions === 'string' &&
      createHash('sha256').update(node.postApproval.instructions).digest('hex') ===
        RETIRED_MERGE_INSTRUCTIONS_SHA256;
    const hasMigratedDeferredRoute =
      node.postApproval.instructions === CODER_OWNED_MERGE_INSTRUCTIONS;
    if (!hasRetiredRoute && !hasMigratedDeferredRoute) return false;
    const mergerAgents = (node.agents ?? []).filter(
      (agent) => agent.name && RETIRED_MERGER_SLOT_NAMES.has(agent.name)
    );
    return (
      mergerAgents.length === 1 &&
      (node.agents?.length ?? 0) === 1 &&
      mergerAgents[0].model === undefined &&
      mergerAgents[0].provider === undefined &&
      mergerAgents[0].thinkingLevel === undefined &&
      mergerAgents[0].replaceAgentPrompt !== true &&
      mergerAgents[0].disabledSkillIds === undefined &&
      mergerAgents[0].extraMcpServers === undefined &&
      mergerAgents[0].resetContextPerTurn === undefined &&
      ((hasRetiredRoute &&
        JSON.stringify(mergerAgents[0].toolGuards) ===
          JSON.stringify([RETIRED_MERGER_RAW_MERGE_GUARD]) &&
        mergerAgents[0].customPrompt?.value === RETIRED_PR_MERGER_SLOT_PROMPT) ||
        (hasMigratedDeferredRoute &&
          mergerAgents[0].toolGuards === undefined &&
          mergerAgents[0].customPrompt?.value === CODER_OWNED_MERGE_PROMPT))
    );
  };
  const hasBuiltInMergerMarker = nodes.some(isPristineMergerNode);
  if (!hasBuiltInMergerMarker) {
    return { nodes, channels, hooks, channelsChanged: false };
  }

  const nodesResult = nodes.filter((node) => node.name !== RETIRED_POST_APPROVAL_NODE);

  const channelsResult = channels?.filter((channel) => {
    if (channel.from === RETIRED_POST_APPROVAL_NODE) return false;
    const targets = Array.isArray(channel.to) ? channel.to : [channel.to];
    return !targets.includes(RETIRED_POST_APPROVAL_NODE);
  });

  const hooksResult = hooks?.filter((hook) => {
    return (
      hook.sourceNode !== RETIRED_POST_APPROVAL_NODE &&
      hook.targetNode !== RETIRED_POST_APPROVAL_NODE
    );
  });

  return {
    nodes: nodesResult,
    channels: channelsResult,
    hooks: hooksResult,
    channelsChanged: (channelsResult?.length ?? 0) !== (channels?.length ?? 0),
  };
}
