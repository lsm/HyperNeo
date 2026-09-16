import {
  CODER_EXTERNAL_GATE_BLOCK,
  CODER_ONLY_MERGE_INSTRUCTIONS,
  CODER_ONLY_PROMPT,
  CODER_OWNED_MERGE_PROMPT,
  CODER_OWNED_PR_SUBSCRIBE_GUIDANCE,
  CODER_OWNED_QA_PROMPT,
  CODER_OWNED_QA_REVIEW_PROMPT,
  CODER_OWNED_REVIEW_PROMPT,
  CODEX_REACTION_APPROVAL_GUIDANCE,
  EXTERNAL_REVIEW_BOTS_GUIDANCE,
  EXTERNAL_REVIEW_BOTS_GUIDANCE_PRE_CHECK_SEEDING,
  EXTERNAL_REVIEW_BOTS_GUIDANCE_PRE_TYPENAME,
  FULLSTACK_CODING_NOCHANGE_GUIDANCE,
  FULLSTACK_QA_POST_APPROVAL_PARAGRAPH,
  RESEARCH_PROMPT,
  RESEARCH_REVIEW_PROMPT,
  REVIEW_ONLY_REVIEW_PROMPT,
  REVIEW_POLICY_GUIDANCE,
  REVIEW_THREAD_APPROVAL_CHECK_GUIDANCE,
  REVIEW_THREAD_RESOLUTION_GUIDANCE,
  REVIEWER_POST_APPROVAL_BLOCKER_PARAGRAPH,
  REVIEWER_ZERO_FINDINGS_GATE,
} from '@hyperneo/prompts';
import type { SpaceWorkflow } from '@hyperneo/shared';
import {
  CODER_ONLY_WORKFLOW,
  CODING_WITH_QA_WORKFLOW,
  CODING_WORKFLOW,
} from './built-in-coding-workflows.ts';
import { RESEARCH_WORKFLOW, REVIEW_ONLY_WORKFLOW } from './built-in-research-workflows.ts';
import { CODER_OWNED_MERGE_INSTRUCTIONS } from './post-approval-merge-template.ts';

export {
  CODER_EXTERNAL_GATE_BLOCK,
  CODER_ONLY_MERGE_INSTRUCTIONS,
  CODER_ONLY_PROMPT,
  CODER_OWNED_MERGE_PROMPT,
  CODER_OWNED_PR_SUBSCRIBE_GUIDANCE,
  CODER_OWNED_QA_PROMPT,
  CODER_OWNED_QA_REVIEW_PROMPT,
  CODER_OWNED_REVIEW_PROMPT,
  CODEX_REACTION_APPROVAL_GUIDANCE,
  EXTERNAL_REVIEW_BOTS_GUIDANCE,
  EXTERNAL_REVIEW_BOTS_GUIDANCE_PRE_CHECK_SEEDING,
  EXTERNAL_REVIEW_BOTS_GUIDANCE_PRE_TYPENAME,
  FULLSTACK_CODING_NOCHANGE_GUIDANCE,
  FULLSTACK_QA_POST_APPROVAL_PARAGRAPH,
  RESEARCH_PROMPT,
  RESEARCH_REVIEW_PROMPT,
  REVIEW_ONLY_REVIEW_PROMPT,
  REVIEW_POLICY_GUIDANCE,
  REVIEW_THREAD_APPROVAL_CHECK_GUIDANCE,
  REVIEW_THREAD_RESOLUTION_GUIDANCE,
  REVIEWER_POST_APPROVAL_BLOCKER_PARAGRAPH,
  REVIEWER_ZERO_FINDINGS_GATE,
};

export {
  CODER_ONLY_WORKFLOW,
  CODING_WITH_QA_WORKFLOW,
  CODING_WORKFLOW,
} from './built-in-coding-workflows.ts';
export { RESEARCH_WORKFLOW, REVIEW_ONLY_WORKFLOW } from './built-in-research-workflows.ts';

export const LEGACY_CODING_TEMPLATE_IDENTITIES = [
  {
    legacyName: 'Coding Workflow',
    legacyHandle: 'coding-workflow',
    name: 'Coding',
    handle: 'coding',
  },
  {
    legacyName: 'Coding with QA Workflow',
    legacyHandle: 'coding-with-qa-workflow',
    name: 'Coding with QA',
    handle: 'coding-with-qa',
  },
] as const;

const LEGACY_BUILT_IN_TEMPLATE_NAMES = new Map<string, string>(
  LEGACY_CODING_TEMPLATE_IDENTITIES.map((identity) => [identity.legacyName, identity.name])
);

export function resolveBuiltInWorkflowTemplate(templateName: string): SpaceWorkflow | undefined {
  const canonicalName = LEGACY_BUILT_IN_TEMPLATE_NAMES.get(templateName) ?? templateName;
  return getBuiltInWorkflows().find((workflow) => workflow.name === canonicalName);
}

export function builtInWorkflowRequiresPrMerge(templateName: string | null | undefined): boolean {
  if (!templateName) return false;
  const template = resolveBuiltInWorkflowTemplate(templateName);
  return (template?.nodes ?? []).some(
    (node) =>
      node.postApproval?.targetAgent !== undefined &&
      (node.postApproval.instructions === CODER_OWNED_MERGE_INSTRUCTIONS ||
        node.postApproval.instructions === CODER_ONLY_MERGE_INSTRUCTIONS)
  );
}

export function getBuiltInWorkflows(): SpaceWorkflow[] {
  const workflows = [
    CODING_WORKFLOW,
    CODING_WITH_QA_WORKFLOW,
    RESEARCH_WORKFLOW,
    REVIEW_ONLY_WORKFLOW,
    CODER_ONLY_WORKFLOW,
  ];
  return workflows;
}
