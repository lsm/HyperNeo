import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { NEO_TOOL_DESCRIPTIONS, neoToolDescription } from '@hyperneo/prompts';
const moved = [
  {
    file: 'card-search-operation.ts',
    name: 'neo.ask.search',
    text: 'Search work cards by text across ask titles, requests, outcomes, todo titles, states, next actions, reports, evidence and question text and answers. Returns pointer rows (askId, todoId or questionId, matched field, score, snippet); open them with neo.ask.read. Terms of three or more characters use substring matching, with titles ranked above status and next actions above reports. A single one- or two-character query uses literal matching across all fields, ordered by recency then id with fixed scores. Mixed queries search only terms of three or more characters.',
  },
  {
    file: 'conversation-read-operation.ts',
    name: 'neo.conversation.read',
    text: 'Read the recorded human and Neo conversation, with the messages root Neo exchanged with other sessions (role session; RPC callers are served the ones Neo sent plus system-forwarded worker batches, each marked kind session or worker-batch so clients hide worker batches from the human), oldest first within each page. With no cursor, returns the newest page. Use nextBefore as before for older history, or nextAfter as after for newer entries. Human words and attachment references come from the immutable intake record; each human ask carries the same daemon-computed messageStatus as neo.conversation.asks.read. Neo replies and revision history come from the publication ledger. Session messages come from message.send records and separately released worker batches; batch disclosures project text only. Scheduled wakes appear as role wake with their summary and attributed additions. Only the current public conversation is readable; SDK transcripts and raw internal notes are excluded.',
  },
  {
    file: 'draft-recovery-operation.ts',
    name: 'neo.draft.recover',
    text: 'Re-save a Neo composer edit captured in this tab before reload. Commits when the saved draft equals its captured base or already equals the edit text. The newest ask from that session counts as submitted only when its text matches and either Preview context was omitted (legacy) or its explicit artifactId/snapshot association matches; null means explicitly unbound. Uses a conditional write and never consumes staged voice.',
  },
  {
    file: 'packs/coding/home/github.ts',
    name: 'neo.home.github',
    text: 'After local setup, propose a private GitHub neo-home once on an open root-Neo ask using askId. Without GitHub it stays local; repeats reuse the stored proposal, including Keep local. To create and push, pass questionId only: requires the human to pick Create private repo on the exact daemon-bound card. External creation is reserved once; creation_unconfirmed needs human reconciliation and never replays. Does not clone or change existing origin. Root Neo or local human only.',
  },
  {
    file: 'home/operations.ts',
    name: 'neo.home.read',
    text: 'Read a complete curated home document and its SHA-256. With origin/upstream, synchronizes using bounded noninteractive fetch and isolated rebase for each read through the same path as a human RPC read. Publishes only a fast-forward that preserves ignored and untracked files. Local-only reads include human edits; synchronization relies on Git merge errors rather than a blanket dirty-state refusal. A sync conflict returns questionId for one human choice with a full-version document; answering alone does not apply it; neo.home.save can apply the exact recorded version choice. includeRemote optionally adds the browser origin URL without fetching. Never initializes or authors a commit. Refuses internal, ignored or symlink paths and non-UTF-8 content. Root Neo or the local user only.',
  },
  {
    file: 'home/operations.ts',
    name: 'neo.home.save',
    text: "Save one curated document and commit locally. With a configured origin/upstream, fetches and rebases in an isolated worktree before a protected fast-forward, then writes and pushes. Network steps are noninteractive and stop after 30 seconds. A conflict leaves the original home untouched and returns questionId for one human choice with a full-version document; answering alone does not apply that choice; conflictQuestionId applies a human Keep local/Use remote answer from its recorded path and version to one regular conflicting document using exact selected bytes and a merge preserving both histories. Multi-file, deletion and Review together choices require further review. Direction/mandate still need a separate exact-path/SHA questionId; the version choice never bypasses it. RPC remote publication uses a revision lease; push_failed retains the named local commit for retry. Allows unrelated staged, edited and untracked home files; commits only the requested document and any confirmed decision log. Refuses credential-like content when origin is configured, and internal/ignored paths. Direction and mandate require questionId: the human's confirmation on a root-Neo question bound to the exact path and content SHA-256. Appends the confirmed decision and commits both files with Neo-Confirmed-By. Root Neo or the local user only; Neo owns its home documents and can edit them with file tools; this RPC commits with attested decisions while Neo owns its unsandboxed Bash writes. This operation retains a human-facing RPC for confirmed mandate/direction receipts with a decision log; direct edits do not attest human approval. Credential publication checks cover these RPC paths; direct remote Git commands follow the prompt rule against publishing credentials and is not constrained by this RPC gate.",
  },
  {
    file: 'home/operations.ts',
    name: 'neo.home.init',
    text: 'Initialize the local Neo home repository, ignore coordinator transcripts, and assign stable project folders. The local human may supply remoteUrl once to clone an existing shared home; origin/upstream remember the selection. Preserves local transcripts and refuses existing documents or a different origin. Clone is noninteractive with a 30-second timeout. After first setup, call neo.home.github with the current root askId to offer its private remote once. Uses the configured git identity; fix identity/signing configuration and retry if commit fails. Root Neo or the local user only.',
  },
  {
    file: 'intake.ts',
    name: 'neo.message.send',
    text: 'Durably accept a human ask into an open Neo conversation without waiting for its coordinator. Supply a new requestId UUID per ask and reuse it only for retries of identical content. Acceptance does not mean the ask has been processed or answered. replyTo {kind, id} quotes a question, todo, ask (work card) or message: every message and reply goes to the one Neo session, and a reply to a question is recorded as its answer, except a start question, where a reply is only a remark and the question stays open. For each photo, thumbnails may carry a small preview { index, mediaType, data, width?, height? } keyed by the photo’s content index; it is stored for conversation pages and never sent to the model.',
  },
  {
    file: 'model-preference.ts',
    name: 'neo.preferences.set',
    text: "Set the primary model, provider and thinking level for Neo and its projects, for the user only. Optional fallbacks stores an ordered preference list; runtime recovery uses the ordinary session policy. An empty list clears saved fallbacks; omitting it preserves the saved chain. Optional autoCompactPercent, on the primary and on each fallback, is an integer clamped to 10–100; the entry for the model the Neo session runs writes the ordinary per-session context-budget setting, and omitting it restores model metadata/default. Percentage edits apply after the current reply; a model switch takes its entry's percentage at once.",
  },
  {
    file: 'packs/coding/assign-operation.ts',
    name: 'neo.coding.assign',
    text: 'Assign Review or Verify on one existing coding todo/PR/head/acceptance contract. Configured bot means no reviewer session; otherwise select a provenance-qualified fresh reviewer or explicit human. Verify starts independently. Candidates are available configurations (default first); shared prefer settings return fallback explanations. Existing exact-head assignments are reused; no merge/completion decisions.\nFor independent review after bot approval, first use work.send for the same todo and reviewer. Then call this operation with handoff {state: "pending", ref, receipt} using its accepted delivery receipt and candidates: []. Bot assignment stays separate. When that review returns or is cancelled, call handoff {state: "returned" or "cancelled", ref}. Missing or uncertain delivery cannot cover a hold.',
  },

  {
    file: 'packs/coding/human-merge-operation.ts',
    name: 'neo.coding.merge.human',
    text: 'When the human chooses to merge a PR themselves, add its human-merge label with enabled:true; remove it with enabled:false when they change their mind. For mergeBy=daemon repos do not chase owners to merge; failed attempts retry with fresh gates after a readable ready OPEN result, up to three failures per head, then report the error to Neo. Pending CI consumes no budget; unreadable outcomes retain their receipt and error. Neo can accept a stopped report with neo.coding.merge.retry using its exact head after fresh gates pass. Configured humanSignoff labels hold daemon merging. Never changes repository preferences.',
  },
  {
    file: 'packs/coding/merge-operation.ts',
    name: 'neo.coding.merge.prepare',
    text: 'Admit a linked coding PR for manual merge using persisted Review/Verify assignments, actual exact-head review, required CI, resolved findings and repository human sign-off. Mirrored plans require a closing reference to the todo issue or its parent. Owner-merged repositories receive a reminder. Re-reads the head, records gates and returns a SHA-pinned command for the caller to execute.',
  },
  {
    file: 'packs/coding/pr-file-operation.ts',
    name: 'neo.coding.pr.file',
    text: 'Attach a complete PR file as an immutable document, never a diff. Owner Neo only. Pass an ask/todo context, GitHub owner/repo#N or PR URL, listed path, current 40-hex headSha and a stable requestId. Reuse the UUID only for identical inputs; a changed head/path/PR needs a fresh UUID. Returns an ArtifactRef usable in neo.question.ask artifacts. Explain changes in card text.',
  },
  {
    file: 'packs/coding/project-tree-operations.ts',
    name: 'neo.project.move',
    text: 'Move an avatar under another parent or root, preserving its asks and context. Any local session; refuses cycles and stale revisions.',
  },
  {
    file: 'packs/coding/project-tree-operations.ts',
    name: 'neo.project.section',
    text: 'Create a section only when needed, from a GitHub epic issue under its code project. It inherits the parent’s workspaces; repeated calls reuse the same section. Any local session.',
  },
  {
    file: 'packs/coding/result-operation.ts',
    name: 'neo.coding.result',
    text: 'Record Review or Verify evidence for the exact persisted coding assignment (legacy qa remains accepted). Requires its todo, worker ref, actor identity, PR head and acceptance-contract reference; rejects stale heads, mismatches and attempts to erase a failure. Bot approval is read from GitHub, never submitted through this operation.',
  },
  {
    file: 'packs/coding/retry-merge-operation.ts',
    name: 'neo.coding.merge.retry',
    text: 'Neo accepts a stopped daemon merge report for an exact PR head after every fresh merge gate passes. Reopens its three-attempt budget without deleting historical failures or changing preferences. Does not merge; the daemon checks all gates again on its next sweep.',
  },
  {
    file: 'packs/coding/smoke-operation.ts',
    name: 'neo.coding.smoke',
    text: 'Record the assigned independent QA actor’s post-deploy smoke or explicit inapplicability. Reads actual merged-head and running-build containment facts; a failure is recorded for follow-up without changing the todo’s declared completion check. Does not merge, deploy or restart anything.',
  },
  {
    file: 'peer-operations.ts',
    name: 'neo.peer.accept',
    text: 'On the current human request, accept a contact invitation at its HTTPS origin. Store the message credential privately.',
  },
  {
    file: 'peer-operations.ts',
    name: 'neo.peer.invite',
    text: 'Invite a contact on the current human request; grants text delivery only.',
  },
  {
    file: 'peer-operations.ts',
    name: 'neo.peer.list',
    text: 'List this instance’s contacts without invitations or credentials.',
  },
  {
    file: 'peer-operations.ts',
    name: 'neo.peer.remove',
    text: 'On the current human request, remove a contact and its message credentials.',
  },
  {
    file: 'peer-operations.ts',
    name: 'neo.peer.send',
    text: 'Send text to one configured contact on a recorded current human request. Receipt means the other Neo accepted it, not that the human read it. Retries keep requestId and content.',
  },
  {
    file: 'project-forget-operation.ts',
    name: 'neo.project.forget',
    text: 'Delete a project at the human’s request: its workspace aliases and row go, so its repositories leave the PR ledger. The repository and local folders are untouched; new work in one of its folders creates a project again. Root Neo or the local human only (root_or_human_only). Settled asks move to the root. Refuses the Inbox (project_protected) and a project that still has child sections, cards, open asks, merges or worker bindings (project_in_use); an unknown id is project_missing.',
  },
  {
    file: 'publication-operation.ts',
    name: 'neo.publication.publish',
    text: 'Deliver a message in this conversation. Use a new requestId per message and reuse it only when retrying that send. session is the worker session this message is about; omit it otherwise. When the latest listening fact is yes, include optional spoken: one or two natural lines consistent with the text, at most 500 characters. Publication is saved first, speech is delivered to the current listener, then clients are notified of the text. No listener silently drops spoken; speech is not stored in publication history. Retries never replay speech. The receipt reports listening and spokenDelivered. If a fresh receipt says listening yes but you supplied no spoken, follow its guidance to call neo.speech.say once; never re-publish the text. text is the message; add details only for a fuller body behind the text. Details shorter than the text fold into the text. Optional replyTo lists the received human message ids this publication answers; when omitted, the human inputs whose turn produced this publication are recorded as answered when they are known. Unknown, foreign, queued and non-human reply ids are omitted. When a reply is about one session the human may want to open, pass session: its exact session id rather than promising a link in text. Unknown session ids reject the publication without saving; correct the id and retry the same requestId. session_lookup_failed means the lookup is unavailable: retry the same requestId and session id. If session is omitted, the daemon fills it only for an unambiguous recorded sender of the current inputs. Only project links are accepted; an unknown project id rejects the entire publication without saving. Correct the link and retry with the same requestId. Unavailable artifact references reject the publication; correct them and retry the same requestId. For a working document, put its absolute path on the owning daemon in the text and say in one sentence what it is. Attach a worker handoff using its publicReference; never expose private work or evidence paths. Preview only files on this daemon. Remote files return owner_unavailable; identify their owner rather than re-publishing their paths as local. Artifacts may contain saved attachments, fixed-head Git references, or verified local Markdown/HTML handoff publicReference values. An existing card-reply handoff must be retained when updating artifacts.',
  },
  {
    file: 'publication-read-operation.ts',
    name: 'neo.publication.read',
    text: 'Read one bounded ascending page of authored Neo replies and full details for the current public conversation. Use nextAfter for the next page or later updates, or pass before (for example Number.MAX_SAFE_INTEGER for the newest page) to read the page that ends just before that sequence; this never reads SDK transcripts or starts a query.',
  },
  {
    file: 'reorganize-operation.ts',
    name: 'neo.projects.reorganize',
    text: "Record each local project's code identity and plan project cleanup, returned in cleanupPlanned. Projects never merge on their own: a merge happens only when a run with apply: true applies a planned merge step (the older project stays; old links and conversations of the merged one keep working). It applies the plan only with apply: true, and the daily pass applies every step except merges on its own. Repository projects are never cleaned up. A project with no repository is deleted when empty and the mirror would not create it again, merged into the repository project where most of its cards ran (else one with its title), and otherwise kept. A project only on another machine is deleted when empty and otherwise left alone. It also runs on its own about once a day, after the human has been away for three hours. Main Neo, the default session or the human only.",
  },
  {
    file: 'session-archive-operation.ts',
    name: 'neo.session.archive',
    text: 'Archive a session by its work.find ref through its driver, through the human caller or a bound Neo session. Refuses sessions a doing todo is working in, running or waiting turns, unsupported drivers and unreadable state. Preserves the conversation. archived false means it was already archived. Managed clean/pushed worktrees are removed after archiving; the optional worktree receipt reports removal or retention with its reason. Changed, unpushed or unverifiable worktrees are kept. An attached daemon must also support this operation.',
  },
  {
    file: 'speech.ts',
    name: 'neo.speech.listen',
    text: 'Enable live spoken replies on this connected human client. No history replay.',
  },
  {
    file: 'speech.ts',
    name: 'neo.speech.say',
    text: 'Speak a short natural utterance independently of chat publications when the human enabled voice replies. Reuse requestId on retries. Acceptance is delivery, not proof of playback. No listener means no speech.',
  },
  {
    file: 'speech.ts',
    name: 'neo.speech.preview',
    text: 'Preview the selected voice through this server.',
  },
  {
    file: 'speech.ts',
    name: 'neo.speech.catalog',
    text: 'List the voices available through this server.',
  },
  {
    file: 'speech.ts',
    name: 'neo.speech.ack',
    text: 'Record playback state for speech delivered to this exact client.',
  },
];
test.each(moved)('$name is loaded verbatim from the prompts package', ({ file, name, text }) => {
  expect(NEO_TOOL_DESCRIPTIONS[name]).toBe(text);
  expect(neoToolDescription(name)).toBe(text);
  const source = readFileSync(new URL(`../../../../src/lib/neo/${file}`, import.meta.url), 'utf8');
  const escapedName = name.replaceAll('.', String.raw`\.`);
  expect(source).toMatch(
    new RegExp(
      String.raw`name: '${escapedName}',\s+description: neoToolDescription\('${escapedName}'\)`
    )
  );
  expect(source).not.toContain(text);
});
