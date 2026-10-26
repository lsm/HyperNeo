export const NEO_REFUSALS: Readonly<Record<string, string>> = {
  merge_receipt_changed:
    'The durable merge receipt does not match these assignments. Re-read the todo and its current-head assignments before preparing a merge.',
  head_changed_before_manual_merge:
    'The head changed during merge preparation. Repeat review, QA and CI gates for the new head.',
  merge_evidence_required:
    'Record the acceptance contract, actor identities and durable review, QA and CI evidence before preparing a merge.',
  independent_matching_head_qa_required:
    'Obtain passing QA evidence from the assigned independent session for this PR, head and acceptance contract.',
  matching_head_review_required:
    'Obtain passing review on the exact current head; a configured bot rejection has no session fallback.',
  merge_requirements_not_satisfied:
    'Keep the pull request open until required CI is green, findings are resolved and repository sign-off is satisfied.',
  matching_merge_gate_required:
    'Record a passing merge gate for this todo, pull request and exact head before recording smoke.',
  independent_qa_required:
    'Only the assigned QA session, distinct from the author and reviewer by full work reference, can record smoke.',
  matching_merge_commit_required:
    'Read the merged pull request again; its head and merge commit must match the authorized gate and smoke.',
  inapplicability_reason_required:
    'Explain why this change has no deployable behavior before recording smoke as inapplicable.',
  running_build_must_contain_merge:
    'Observe the named running build and confirm it contains the merge commit before recording smoke.',
  already_claimed:
    'Another start already claimed this card. Read the card with neo.snapshot and wait for that start to finish instead of starting it again.',
  already_corrected:
    'This reply already has a correction, and a correction cannot itself be corrected. Publish any further change as a new reply.',
  already_edited:
    'This reply was already edited in this turn. Make one edit per message per turn; a new fact goes out as its own reply.',
  already_started:
    'This card already has a working session. Use neo.work.continue to send it more instructions instead of starting it again.',
  ambiguous_target_agent:
    'More than one agent owns that session, so the target is ambiguous. Propose the work against one specific agent session.',
  approval_expired:
    'The human’s approval of this ask has run out. Ask the human to approve it again before starting work.',
  approval_stale:
    'The ask changed after the human approved it, so that approval no longer covers it. Ask the human to approve the current revision.',
  ask_not_live:
    'The ask behind this card is already achieved or abandoned, so its cards cannot start or bind. Open a new ask for new work.',
  binding_already_dispatched:
    'That item is bound to a card that already started, so its binding is fixed. Bind it again only after that card fails or is cancelled.',
  binding_card_not_owned:
    'The card named in deliveredBy does not belong to this ask. Bind items only to this ask’s own cards.',
  card_not_active:
    'The card is no longer proposed or queued, so it cannot start. Read its status with neo.snapshot; propose a new card if work is still needed.',
  conversation_not_found:
    'No Neo conversation has that conversationId. Pass the id of an existing Neo conversation.',
  dependency_already_dispatched:
    'The card has already started, so its dependencies can no longer change in a way that voids approval. Change dependencies only on a proposed card that has not started.',
  dependency_ask_not_live:
    'The card’s ask is achieved or abandoned, so its dependencies cannot change. Edit dependencies only on cards of a live ask.',
  dependency_cycle:
    'These dependencies would make the card wait on itself through a cycle. Remove the edge that closes the cycle.',
  dependency_not_visible:
    'A card in this dependency edit does not exist or is not visible to this ask. Use card ids from this ask’s neo.snapshot.',
  dependency_outcomes_missing:
    'Every card in a dependency must have outcome items. Bind the prerequisite cards’ items with delivers first.',
  dependency_rejected:
    'The dependency change was not accepted. Read the card’s dependencies with neo.snapshot and send a valid edit.',
  dependent_cancelled:
    'The card is cancelled, so it cannot gain dependencies. Propose a new card instead.',
  duplicate_dependency:
    'The same prerequisite card is listed more than once. Name each prerequisite once.',
  duplicate_setting:
    'The proposal lists the same pack, scope and key more than once. Include each setting once.',
  edit_unchanged:
    'The edit leaves the reply exactly as it was. Pass the changed wording, or skip the edit.',
  head_changed_or_failed_stage:
    'The PR head changed or this stage already failed. Read the current assignment and findings; validate the current head rather than replacing a failure with a pass.',
  epic_unavailable:
    'The GitHub epic could not be read or has no title. Check the URL and access, then try again.',
  handoff_uncertain:
    'An earlier start of this card was interrupted, so it is unknown whether a working session exists. Check with neo.snapshot before starting it again.',
  human_ask_required:
    'This needs the human’s own message behind it, and none was found for this turn. Use it while answering the human’s chat message.',
  reader_not_authorized:
    'Conversation history is available to the human or a bound Neo coordinator during its live turn.',
  human_only: 'Only the human can do this, from the app. Ask the human instead.',
  identity_conflict:
    'The two projects belong to different repositories, so they cannot merge. Merge only projects with the same repository identity.',
  image_not_found:
    'No image with that imageId is in this conversation. Use an imageId from the conversation’s messages.',
  invalid_agent_reference:
    'The agent reference does not match the target session. Pass the agent and session ids exactly as work.find returned them.',
  invalid_epic_url:
    'The epic must be a GitHub issue URL such as https://github.com/owner/repo/issues/123. Pass the issue’s URL.',
  invalid_input: 'The input does not match this operation’s schema. Fix the fields and try again.',
  invalid_outcome_binding:
    'An outcome binding names an item that is missing, removed, or listed twice. Use each open item id from this ask once.',
  invalid_preparation_directory:
    'The preparation directory and destination must be different absolute paths. Pass two distinct absolute paths.',
  invalid_preparation_target:
    'The target is not a valid git branch name. Pass a branch name without empty, dotted or .lock parts.',
  invalid_prepared_commit:
    'Preparing the workspace did not produce a valid commit id. Check the repository and try again.',
  invalid_prerequisite_commits:
    'Prerequisite commits must be full 40- or 64-character commit ids. Pass full commit ids.',
  invalid_publication:
    'The reply does not match the publication schema. Fix the fields and publish again.',
  invalid_recipient_binding:
    'This session is not the one bound to the card, so it cannot report on it. Report from the card’s working session.',
  invalid_reply_to:
    'A replyTo id is not a consumed human message in this Neo conversation. Cite received human message ids from this conversation, or omit replyTo to leave attribution unspecified.',
  invalid_report:
    'A report needs status reported or failed and at most 12000 characters of text. Fix the report and send it again.',
  invalid_target_binding:
    'The target session is bound to a different card. Pick a session that is free, or no target.',
  invalid_target_reference:
    'targetSessionId must be a non-empty session id or null. Pass a real session id, or null for a new session.',
  invalid_work_id: 'The card id is empty. Pass a card id from neo.snapshot.',
  avatar_required:
    'Only Neo’s own session for this conversation can publish. Use that session’s publication tool.',
  local_session_required:
    'Changing the project tree needs a daemon session or the local CLI. Run it from a session or as the local user.',
  main_neo_only:
    'Only main Neo or the human can do this. Ask main Neo to do it, or do it from main.',
  needs_human:
    'Merging a project without a repository identity needs the human’s approval. Ask the human, then retry with humanApproved.',
  no_driver_target:
    'The card has no place to run its work. Propose it with a work target, such as a repository or a session.',
  not_approved:
    'The human has not approved this ask yet. Ask the human to approve it before starting work.',
  open_ask_required:
    'Settings questions need an open ask. Use the id of an open ask from neo.snapshot.',
  opened_check_unbound:
    'A PR-opened check is met when the PR opens; no card delivers it. Leave it out of delivers.',
  prerequisite_ref_missing:
    'A prerequisite has no PR to watch yet. Wait until the prerequisite card opens its PR.',
  prerequisite_ref_unreadable: 'A prerequisite PR could not be read right now. Try again shortly.',
  prerequisites_unmet:
    'The card’s prerequisites are not done yet. It starts by itself once they are met.',
  project_in_use:
    'The project still has sections, cards, open asks, merges or a bound worker, so it cannot be forgotten. Settle its open asks and move its cards and sections first.',
  project_missing: 'No project has that id. Read the project ids from neo.snapshot.',
  project_protected: 'The Inbox is a system project and cannot be forgotten. Pick another project.',
  proposal_is_immutable:
    'This requestId already binds a different proposal. Keep its stored values, or ask a new question with a new requestId.',
  publication_superseded:
    'This turn’s session or conversation changed after the reply was prepared, so it cannot publish. Publish from the current live turn.',
  question_closed:
    'This question is already answered or retired. Read it with neo.question.get; use a new requestId if the human needs a new question.',
  recipient_is_coordinator:
    'Neo sessions do not report on cards; working sessions do. Report from the card’s working session.',
  recipient_mismatch:
    'This session is not the card’s working session. Report only on cards this session is working on.',
  recipient_required:
    'A report must come from an agent session. Send it from the card’s working session.',
  remote_default_unavailable:
    'The remote’s default branch could not be read. Pass an explicit target branch, or check the remote.',
  report_conflict:
    'This card already has a different report. Read it with neo.snapshot; a card is reported once.',
  root_or_human_only:
    'Only main Neo or the human can change the project tree. Ask main Neo to do it.',
  self_dependency: 'A card cannot depend on itself. Remove its own id from dependsOn.',
  session_not_found: 'No Neo session has that sessionId. Pass the id of an existing Neo session.',
  stage_assignment_mismatch:
    'The result does not match the assigned coding actor, worker ref, PR head or acceptance contract. Submit evidence for the exact persisted assignment.',
  stale_ask_revision:
    'The ask changed since you read it. Read it again with neo.snapshot and pass its current revision.',
  submitted: 'That draft was already sent as a message, so there is nothing to recover.',
  superseded:
    'Something newer replaced what this acted on. Read the current state and act on that.',
  target_agent_not_active: 'The target agent is not active. Pick an active agent, or no target.',
  target_agent_unavailable:
    'The target agent is not available in that space. Pick an agent from work.find.',
  target_is_coordinator:
    'The target is a Neo session, which cannot take work. Pick a working session, or no target.',
  target_owned_context:
    'The target session is already bound to Neo, as a Neo session or another card’s working session. Pick an unbound session, or no target.',
  target_session_not_active:
    'The target session is not active. Pick an active session, or no target for a new one.',
  target_session_not_found:
    'No session on this daemon has that id. Use a session id from work.find, or no target for a new one.',
  target_space_not_active:
    'The target agent’s space is paused, stopped or inactive. Pick another target, or ask the human to resume the space.',
  unknown_ask:
    'The message this turn is answering cannot be found or has no text, so there is nothing to forward. Answer it here.',
  unknown_parent:
    'The parent project does not exist, or is the Inbox. Use a project id from neo.snapshot.',
  unknown_project: 'No project has that id. Use one of the listed projects, or main.',
  unreachable: 'The daemon that holds that session could not be reached. Try again later.',
  unsafe_tree: 'Only sibling projects under the same parent can merge. Move one first, then merge.',
  work_not_found: 'No card has that id. Use a card id from neo.snapshot.',
  work_not_pending: 'The card is not waiting for a report. Read its status with neo.snapshot.',
};

export function explainNeoRefusal<T>(value: T): T {
  if (!value || typeof value !== 'object') return value;
  const refusal = value as { ok?: unknown; accepted?: unknown; reason?: unknown; detail?: unknown };
  const explained =
    (refusal.ok === false || refusal.accepted === false) &&
    typeof refusal.reason === 'string' &&
    typeof refusal.detail !== 'string' &&
    Object.hasOwn(NEO_REFUSALS, refusal.reason)
      ? NEO_REFUSALS[refusal.reason]
      : null;
  return explained ? { ...value, reason: `${refusal.reason}: ${explained}` } : value;
}
