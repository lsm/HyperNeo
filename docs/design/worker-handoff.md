# Worker handoff: preserve the report, simplify delivery

Status: human approved (question 13e4f9b2); implementation ships in the five PRs below. Scope:
local HyperNeo worker → Neo handoff, with existing remote routing kept intact.

## Evidence and diagnosis

Read-only inspection of session `2da30ccd-2212-4a7e-b1c3-f2ff46d77dc5`
found a **7,927-character assistant report at SDK seq 100353**, also present in
result seq 100354 and currently in the search index. Later follow-ups displaced
it from the default tail. Seq 100813 is a separate, short file-delivery reply;
the `/tmp` workaround produced an 8,062-byte report. This is a retrieval and
handoff failure, not evidence of lost stored text. Historical search-index state
and the precise todo attribution at the incident are not recoverable from this
inspection; the suspected paths below need reproductions before implementation.

| Part | First wrong decision / current boundary | Proposed change |
|---|---|---|
| Send | [`message-send.ts:40`](../../packages/daemon/src/lib/messaging/message-send.ts#L40) requires the SDK envelope; [`invoke.ts:77`](../../packages/daemon/src/lib/operations/invoke.ts#L77) returns schema diagnostics without a corrective example. Incident calls repeatedly omitted `type` or `parent_tool_use_id`. | Extend **the same `message.send` operation** with `{to, text, files?}`; normalize once into its current admission, identity, routing and persistence pipeline. Keep the existing SDK shape accepted. Invalid input includes a minimal valid example for each shape. |
| File | The worker's workspace is under the daemon data directory. [`session-policy.ts:110`](../../packages/daemon/src/lib/neo/session-policy.ts#L110) grants Neo only its own workspace; [`look-up-guard.ts:190`](../../packages/daemon/src/lib/neo/look-up-guard.ts#L190) blocks other data-directory paths after canonicalization. | Add a daemon-managed **per-session outbox**, explicitly writable by that worker and readable by Neo through the narrow exception below. Do not allow another worker's workspace or all of `~/.hyperneo`. |
| Reply | [`work-turns.ts:3`](../../packages/daemon/src/storage/work-turns.ts#L3) cuts text at 4,000 characters; lines 39–75 read a bounded search-index tail. [`hyperneo-adapter.ts:409`](../../packages/daemon/src/lib/drivers/hyperneo-adapter.ts#L409) projects agent replies from `result` only. [`driver-work.ts:372`](../../packages/daemon/src/lib/neo/driver-work.ts#L372) cuts attribution at the next user input, and line 498 can turn an empty observed exchange into “without a written reply.” | Read local conversation replies from authoritative SDK storage, with stable anchors and continuation cursors. Bind todo reports to the acknowledged input and actual consumed-turn evidence, rather than a search tail or text match alone. Preserve assistant text when a result has no text; deduplicate when both contain the reply. |
| Answered | [`coordinator-turn.ts:95`](../../packages/daemon/src/lib/neo/coordinator-turn.ts#L95) tracks carried human inputs internally, but its identity exposes one original trigger. [`publication-operation.ts:78`](../../packages/daemon/src/lib/neo/publication-operation.ts#L78) **already accepts an explicit alternate delivered human trigger**. The missing link is making that ID available with the input. | Surface daemon-authored human message IDs and `triggerId` in every human input envelope, including mid-turn delivery. Neo selects the human input it actually answers using the existing publication field. |

## Contract and boundaries

**Outbox.** Use `<dataDir>/handoffs/<sessionId>/`, outside disposable worktrees.
The daemon creates it with owner-only permissions and gives the bound worker
that directory as an SDK write root. A worker writes a draft there; publication
snapshots it into an immutable artifact owned by the daemon. The receipt contains
`artifactId`, originating daemon/session, display name, byte length and SHA-256.
Messages and todo reports carry these structured references plus the readable
artifact path. Paths are local to their originating daemon; remote delivery must
transfer the artifact explicitly or report unavailable, never reinterpret a path.

Neo's read guard admits only the canonical published-artifact subtree; it keeps
all other data-directory, credential-name and secret-file checks. Publication
accepts only regular files from the caller's registered draft directory: reject
traversal, symlinks, hard links and cross-session references; snapshot through the
validated open descriptor, not a second path lookup. Published artifacts are immutable through the API/SDK contract: publication never
clobbers an existing snapshot. Workers and the daemon share an OS uid; this is
**not OS isolation against same-user Bash**. A same-user worker can tamper with
a file. Every reference carries its SHA-256, and a verified read returns
`tampered` without content when the bytes differ. No arbitrary source paths or implicit file reads
are added to `message.send`. The daemon derives sender identity as it does today.

**Retention and size.** Never auto-delete results, including on session/worktree
cleanup. Only explicit human deletion removes published artifacts. Proposed
inline limit: **4 KiB UTF-8**; larger `text` is saved in full and delivered as an
artifact reference with a short descriptor, not a truncated report. Stream file
publication and reads in bounded **256 KiB chunks**, without a total-result trim
or expiry. Existing transport limits still apply to each request; size errors
name the limit and supported file/chunk path. Disk-full is a factual failure,
never a successful receipt or a reason to erase older results. Finalization,
hashing and delivery receipts survive restart and retries without duplicate sends.

PR1 provides `handoff.publish {name}` and `handoff.read {reference, offset?, length?}`.
The worker receives `HYPERNEO_HANDOFF_DIR` as its explicit SDK draft write root.
Names are single non-secret filenames of at most 128 ASCII characters; file
contents may be arbitrary bytes. Content-addressed published paths embed SHA-256
and retain their originating session and persistent local daemon id. Reads hash
the entire descriptor stream before returning a base64 chunk (maximum 256 KiB);
`nextOffset`/`complete` allow complete retrieval without trimming. Neo native Read
uses the same hash preflight. Drafts, outbox parent directories, searches/shell
reads of private daemon data and secret filenames remain outside its exception.
The native SDK Read tool still owns its subsequent filesystem open; the verified
operation returns only bytes captured from the descriptor it hashed. Neither
interface claims protection against a same-user process changing the SDK itself.
PR2 accepts `message.send {to, text, files?, idempotencyKey?}` as well as the
legacy nested SDK envelope. `files` contains complete published references, not
source paths. At most 20 explicit references are accepted per send; additional
references can be sent in another message without trimming any artifact. Spill
writes use unique exclusive drafts, closed before publication, so interrupted
drafts and concurrent sends cannot poison later reports. Workers may attach their own artifacts; Neo and the human may
forward existing published artifacts. New simple text over 4 KiB UTF-8 is
published through the same outbox path and replaced by a descriptor plus structured
references in the mailbox. Legacy envelope content stays unchanged. Local
references on a remote send report unavailable until explicit artifact transfer
exists; plain remote routing stays intact.

An optional sender-scoped `idempotencyKey` binds to the normalized request. Its
accepted receipt is stored atomically with mailbox enqueueing and survives job
cleanup and daemon restart; a different request with the same key is rejected.
Calls without a key keep the existing rate/content-duplicate behavior. CLI sends
use the simple shape. Schema errors include both complete input examples; the
Unix door's 256 KiB request limit explains publication and reference delivery for
larger files. No artifacts or receipts expire automatically.

**Reads and reports.** Keep existing `work.read` response compatibility; add
explicit continuation/availability metadata for complete text and file references.
Local reads use the SDK repository's body access, respecting the staged body-table
fallback; external driver reads keep their existing source. Only visible human
and assistant text is returned, never hidden tool/thinking material. Stored tool
results remain untouched. A partial or unlocated exchange reports `incomplete`
or `reply_unavailable`, not a claim that no written reply exists. Mid-turn human
inputs must not sever attribution of a final reply to the still-running task;
unrelated later turns must not be attributed to it either.

**Answered linking choice: expose IDs.** Automatically answering the oldest human
input with the next publication could mark a todo progress update as its answer.
Instead, provide the ID as trusted metadata, separate from user text; keep the
publication's producer trigger and answered-human trigger distinct. Validate
session ownership and actual delivery/consumption in the active turn. Mark the
chosen human message answered only after durable publication; retries are
idempotent. One publication does not silently answer every consumed human input.

Local SDK `work.read` pages retain the existing `sessionId` and `turns` fields and
add `availability`, `nextCursor`, and per-turn `textOffset`/`textComplete` plus
structured `files` when present. Pass `nextCursor` back as `cursor`; it is scoped
to the session and uses SDK sequence anchors, preserving the selected window
across later appends. Text chunks budget 16,000 serialized UTF-8 bytes to stay
below the SDK tool-output persistence threshold. Reassemble a message's chunks
in cursor order; whitespace and Unicode are preserved. `complete` describes the
retrieved history window, not task completion. Result matching inspects the selected
page plus at most 16 preceding records and does not cross a distinct visible
result. Unscanned history remains available through cursors; an exhausted
continuation is `complete` even when its final page contains only textless rows. An unavailable anchor returns
`reply_unavailable`; an external driver's existing indexed source is unchanged.

## Small PR sequence and acceptance

Production-line estimates are contracts to remeasure against fresh `dev`; tests
ride their change. Each bug gets a committed failing reproduction before its fix.

1. **Outbox artifacts** (~150–200 production lines): daemon storage/lifecycle,
   worker write-root registration and exact Neo guard exception. Test cross-session
   paths, symlink/hard-link races, secret names, restart, disk-full and retention
   through workspace removal. Verify a worker-created synthetic report is readable
   through Neo's actual Read door, while a sibling data-directory file is denied.
2. **Simple `message.send`** (~100–180 lines; depends on 1): schema normalization,
   spill and references using existing send pipeline. Test both shapes, useful
   errors, UTF-8 boundary, 8 KiB report byte/hash equality, identity, remote
   unavailable behavior and retry receipts. Verify through `invoke`, sender to Neo.
3. **Authoritative `work.read`** (~100–180 lines; depends on 1 for references):
   repository-backed paging. Test empty/pending search index, an older long final
   reply behind follow-ups, stable cursors, result/assistant deduplication and full
   round-trip text. Verify the real `work.read` door retrieves all report bytes.
4. **Todo reply attribution** (~100–180 lines; depends on 3): reuse authoritative
   reply selection and receipts. Reproduce task → mid-turn human input → final
   report, then a separate later turn; verify the todo carries its complete report
   or file, and incomplete history never becomes a false “no written reply.”
5. **Human input IDs** (~100–180 lines; independent of 1–4): input envelopes and
   existing publication linkage. Test a todo-triggered turn receiving two human
   inputs, explicit answers, foreign/unconsumed IDs and crash/retry. Verify the
   intended chat message changes from Received to Answered after publication.

Implementation PRs update the verify skill with these journeys and retain
synthetic RPC evidence. No live DB writes/copies, credential reads or unattended
GUI tests. This design PR changes documentation only; none of the proposed
behavior is claimed implemented or verified.
