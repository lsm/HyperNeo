# In-app artifact previews

Status: proposal for human approval. Tracks [#7934](https://github.com/lsm/HyperNeo/issues/7934).
This PR changes this page only. Build nothing until Neo relays the human's approval.
Merge this design only after that approval, hyperneo-ai-test approval of the exact
latest head, and green CI; squash manually. A blocked review engine means hold and
report to Neo, not substitute an agent's own approval.

## What the human sees

Neo and workers produce useful Markdown, HTML, designs and evidence, but a laptop
file path is not a usable deliverable on a phone. A tap in a Neo message or work
card should open the thing inside HyperNeo, on web and iOS.

Example: a worker registers `evidence/layout-report.html`, then Neo sends one line:

> Layout report · HTML · 84 KiB · Open preview

The human taps it, sees the page, goes back, and keeps their conversation position.
The preview still works after the worker stops, its worktree is removed, and the
daemon restarts. A design doc opens as formatted Markdown; a PR link opens a PR
summary with its design/evidence files. Raw source and Download remain explicit
actions. A missing or forbidden reference shows an in-app explanation, not an OS
file-open dialog or a request to paste the document into chat.

The first release previews static HTML. Script-dependent visualizations show a
"Scripts disabled" notice with Source and Download. Interactive HTML execution
is a separate approval decision, not a hidden consequence of opening a file.
This is a document viewer, separate from the agent-controlled browser proposed in
[in-app-browser.md](in-app-browser.md).

## Existing seams to reuse

- Web chat already uses `packages/web/src/components/chat/MarkdownRenderer.tsx`,
  including from `NeoPublicConversation.tsx`. Reuse its Markdown, code and theme
  rendering; add a reference/asset policy rather than a second Markdown parser.
- `workflow.run.artifact.save/list` and `WorkflowRunArtifactRepository` store
  structured workflow facts, not general file bytes. Keep those contracts. A
  workflow fact may link to a preview ID; do not repurpose its upsert as storage
  for mutable HTML or introduce a second workflow state machine.
- Neo publication links currently describe project/work/consultation navigation.
  Add a separate optional `artifacts` field to message/card projections, with
  matching shared types, validation, persistence and clients. Keep old messages
  readable without rewriting history or stuffing file data into publication text.
- The iOS client is [lsm/neo-ios](https://github.com/lsm/neo-ios):
  `Neo/Views/MarkdownText.swift`, `MessageView.swift` and work/ask card views are
  the corresponding rendering/navigation seams. Use its chat Markdown renderer
  and existing daemon connection. Swift changes belong in that repo's own PRs.

## References and short cards

Registered references carry `{daemonId, artifactId, title, kind, byteLength}`;
these are hints until the daemon authorizes and returns current metadata. The
durable reference is the daemon ID plus artifact ID, never a local path or an
authentication token. The in-app route is `/artifacts/<artifactId>` under the
selected daemon connection; copied links carry daemon identity without secrets.

Both clients recognize Markdown links, inline-code paths and standalone path
tokens in ordinary message/card text. Do not guess paths out of arbitrary code
blocks or execute command-looking text. A path with spaces can be an explicit
Markdown link or registered reference. Existing user text remains selectable.
References are navigation candidates, not filesystem permissions.

| Reference | Tap result |
| --- | --- |
| Registered artifact | Authorized preview of the exact saved bytes. |
| Absolute file path | Resolve only within the message/card's bound workspace or approved evidence roots; capture a snapshot, then preview. Intercept `file:` links locally, never ask the phone to read them. |
| `docs/design/example.md` or another repo path | Resolve against the bound repository/worktree and revision. Never use the daemon's process working directory. An unbound or ambiguous repo needs a picker among already authorized contexts. |
| GitHub PR link | In-app PR title, body, status and changed-file list. Selecting a supported file previews bytes from the displayed immutable head SHA. External GitHub remains an explicit action. |

Unregistered references are resolved only on the human's tap, not by reading all
paths during message rendering. For agents, successful registration returns a
ready-to-publish reference. Neo and worker guidance prefer a one-line card plus
one sentence of context over pasting full documents. Do not truncate or replace
the stored message, evidence or source file. Several artifacts get a short list;
the open card supplies metadata, revision, full preview and downloads.

## Registration, storage and lifetime

`artifact.file.register` captures a regular file on the owning daemon. The caller
supplies an existing work/ask context, a path, a short title and a stable request
ID. Ownership and eligible roots come from persisted bindings and operation
caller identity, not caller-supplied owner IDs. Neo can publish within its bound
context; a worker can register only for work it owns. This grants neither actor
new filesystem roots, sharing rights nor permission to read other sessions.

The daemon validates and opens the source, streams a complete snapshot into its
managed store, computes SHA-256, and commits a registry receipt before returning
an artifact ID. Read from that opened file descriptor, not a second path lookup.
Compare descriptor identity, size and modification/change times before and after
capture; refuse changes rather than returning a mixed-version report. Producers
should finish a file with atomic rename before registering it.
Registration never moves, rewrites or deletes the source. Changed content creates
a new immutable ID; retrying a request ID with a different source/hash is refused.
An identical retry returns its original receipt, even after source removal.

Store metadata in SQLite and complete bytes beneath
`<daemon-data-dir>/artifacts/blobs/<sha256>`. Metadata includes type, byte count,
hash, title, producing WorkRef, authorized parent context, creation time and
relative source/revision provenance. Absolute machine paths are not sent to the
phone. Hashes allow internal deduplication, not public hash-based lookup. Agent
DB-query surfaces cannot edit the registry or authorize reads of the blob store.
Use a crash-safe staging/commit protocol: no visible receipt before durable bytes;
interrupted captures remain identifiable for recovery, never silently swept.

| Proposed default limit | Behavior at the limit |
| --- | --- |
| 64 MiB per complete artifact | Reject larger registration with actual size and limit; do not save a truncated replacement. |
| 2 MiB Markdown/HTML rendering | Larger snapshots remain downloadable; show a bounded source excerpt, not a partial page pretending to be the whole document. |
| 256 KiB JSON/log/text preview | Show bounded head/tail text, omitted-byte count and Download complete file. Truncation is a view operation only. |
| 32 MiB and 16 megapixels for image decoding | Oversized/unsupported images stay downloadable, with a clear preview limit. |
| 10 GiB retained blob storage per daemon | Warn at 80%; reserve quota across concurrent captures and refuse new storage at the cap. Never evict existing artifacts to make room. |

Limits are human-controlled daemon policy, not worker overrides. The initial
release accepts individual files. Later explicit bundles may include relative
CSS/images only: at most 64 entries and 64 MiB total, each admitted by the same
path/type checks. Never crawl neighboring directories or fetch remote assets.
Until bundle support ships, producers should export self-contained HTML.

Snapshots have no automatic expiry. Finishing a todo, archiving a session,
removing a worktree, upgrading or exceeding quota must not remove them. Originals
remain user data too. The first release has no deletion operation. Any later
cleanup requires a separate human-only, explicit confirmation showing affected
artifacts and bytes; it must account for shared blobs and preserve a visible
tombstone instead of breaking historical links silently. Logs and backups must
not become an undisclosed second copy of full document bodies.

## Access and safe file capture

The paired human reads artifacts through the existing authenticated daemon
connection from web or phone. Authorization is checked on metadata, every byte
read and download, not just on registration. Artifact IDs are not bearer grants.
Agents read only artifacts within their existing work/context authority. A
copied link confers no access; revoking a connection or parent access revokes
future reads. Offline copies already explicitly downloaded cannot be revoked.
Use the daemon's existing access model; this feature creates no public sharing,
anonymous endpoint or promise of isolation between devices paired as one user.

Eligible source roots are daemon-known workspaces bound to the context and
explicitly human-approved evidence directories. A producer cannot add roots.
A generated Codex visualization outside these roots must be exported into an
eligible evidence/workspace directory, or the human must approve that specific
evidence root. Do not automatically allow all of `~/.codex`, HOME or `/tmp`.
Root policy cannot be broadened to HOME, filesystem root or a credential store.

Before reading bytes, reject traversal, NULs, alternate encodings of separators,
nonregular files, device/FIFO/socket paths and all symlinks in the path. Enforce
containment using an anchored descriptor walk or equivalent OS-enforced
beneath-root open, with no-follow behavior for every component. A realpath prefix
check followed by ordinary open is insufficient: parent swaps can race it.
Reject hard-linked source files and recheck descriptor identity/size during the
copy. If a supported runtime/platform cannot enforce this open contract, return
`safe_open_unavailable`; do not fall back to a racy file read. Pin platform seams
and prove races before wiring registration on Bun and Deno.

Root allowance never overrides the sensitive-file deny policy: `.ssh`, `.git`
internals, keychains, private keys, `.env*`, auth/credentials JSON, token stores,
daemon databases and their backups are forbidden, including nested copies with
those names. Reuse/extend the existing sensitive-path policy where applicable;
never read the real files in tests. An allowed evidence file can still contain
private prose: show the destination/context at registration and keep it private
by default. Path controls do not claim to detect every secret copied into an
innocuously named report or constrain a malicious program with the same OS user.
Enforcement is in the operation and file-open boundary, never command-line parsing.

## API and transport contract

Add operations to the existing registry, caller policy and MCP/RPC door. Domain
refusals are typed results, including `outside_roots`, `sensitive_path`,
`unsafe_path`, `source_changed`, `size_limit`, `quota_full`, `unsupported_type`,
`ambiguous_context`, `safe_open_unavailable`, and a nonrevealing unavailable result
for missing/unauthorized artifacts. Do not leak paths or file existence in errors.

| Proposed operation | Input / result |
| --- | --- |
| `artifact.file.register` | `{requestId, context, path, title}` → authorized immutable `ArtifactRef`; kind is validated from extension, MIME and bytes, not trusted as executable content. |
| `artifact.file.get` / `artifact.file.list` | ID / authorized context plus cursor → metadata; no global cross-context search for workers. |
| `artifact.file.read` | `{artifactId, offset, maxBytes}` → bounded base64 bytes, next offset, complete size and hash; at most 256 KiB decoded per call. Offsets address the immutable snapshot. |
| `artifact.reference.resolve` | `{requestId, sourceMessageOrCard, reference}` → artifact ref or PR preview; validate that reference against that stored source and derive its context server-side. A source ID alone cannot authorize arbitrary paths. |

Resolve requires a caller-owned UUID `requestId` for each new tap, reused on retries.
Missing IDs fail input validation before any receipt is created.

The human's download action streams all chunks with backpressure and integrity
checking through this authenticated operation path. Cancel stops transfer,
without deleting the registered snapshot. Avoid a second raw-path HTTP reader,
tokens in URLs, public blob URLs or a new unauthenticated port. Keep bytes out of
snapshot/event broadcasts; cards carry small authorized metadata only. Recheck
access across reconnects and clear local preview buffers on disconnect/revocation.

Resolve a local repo document to its captured bytes and recorded revision. Label
uncommitted content as a worktree snapshot with its hash and optional base commit,
not as the bytes at HEAD. An explicitly requested commit reads that Git blob. For
PRs without a local checkout, use the existing GitHub service/credentials path
and repository authorization; add bounded content reads at the exact head SHA.
Allow known GitHub hosts/repos only, not arbitrary URL fetching or redirect
following. Do not send GitHub credentials to clients or render GitHub HTML.
Moving PR heads never silently change an already registered artifact: display
its SHA and offer a separate latest-version action. A remote worker registers
on its owning daemon; clients select an existing paired connection or show
"Owning daemon unavailable". Never reinterpret its path on another machine.

## Rendering boundaries

The authenticated host app fetches bytes. Artifact content is untrusted data;
it never receives an operation client, auth header, cookie jar, native bridge,
session object or app-origin DOM access.

| Kind | Preview |
| --- | --- |
| Markdown | Existing chat renderer on each client, with raw HTML inert and the artifact reference resolver for links. Resolve relative assets only from registered bundle entries; no ambient filesystem or remote image loads. |
| HTML | Host-created sanitized `srcdoc` in `<iframe sandbox="">` on web. Disable all scripts, event handlers, forms, popups, downloads and top navigation. No `allow-same-origin`; never insert artifact HTML into the app DOM. |
| Images | Bounded PNG/JPEG/WebP/GIF decoding, fit/zoom and alt text. SVG is source/download in the first release, not an active document. |
| JSON / logs | Escaped monospace text, JSON formatting only within the preview limit; head/tail omission indicator, Copy visible, Download complete. ANSI/HTML stays inert. |

For HTML, the trusted host prepares a new document, removing authored CSP/refresh
meta tags, base elements, embedded frames, SVG/MathML, active links/forms and
external loads, using a parser and explicit element/attribute allowlist.
Keep inline style and embedded raster images for static layouts. Prepend its own
CSP before content: `default-src 'none'; script-src 'none'; connect-src 'none';
style-src 'unsafe-inline'; img-src data: blob:; font-src 'none'; media-src 'none';
object-src 'none'; frame-src 'none'; worker-src 'none'; base-uri 'none';
form-action 'none'`. External links become host-rendered explicit actions after
URL validation, outside the frame. Never trust a page's own security policy.

The iframe sandbox is the containment boundary; CSP adds resource restrictions.
The [CSP sandbox directive](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/sandbox)
is not effective in a meta tag: do not pretend a `srcdoc` meta supplies it.
The [iframe sandbox](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/iframe)
must retain an opaque origin. No script execution ships in this plan. A later
human-only opt-in must be bound to one artifact hash and viewing session, retain
opaque-origin isolation and block all network/navigation exfiltration. CSP
`connect-src` alone does not block document navigation; do not enable scripts
until web and iOS independently prove that stronger boundary. No agent can opt in.

On iOS, Markdown uses `MarkdownText`; HTML uses a dedicated WKWebView with a
[nonpersistent data store](https://developer.apple.com/documentation/webkit/wkwebsitedatastore/nonpersistent())
and [content JavaScript disabled](https://developer.apple.com/documentation/webkit/wkwebpagepreferences/allowscontentjavascript).
Render a trusted wrapper containing the same sandboxed document and CSP policy.
The wrapper receives no daemon cookies/auth, app script-message handlers, file
read grants or privileged URL schemes. Fetch bytes with the app's existing
authenticated connection, not by loading a daemon URL in WKWebView. Navigation
and resource policies deny network/file access and unexpected scheme requests;
link actions go through the host. Nonpersistent storage alone is not a sandbox.

## Web and phone navigation

On wide web layouts, Open preview opens a right-hand panel. Narrow web layouts
and iOS use a full-height sheet with Back, title, type, size and revision, then
Preview / Source / Download actions. iOS's Share action exports a complete file
after explicit download; it does not share an authenticated internal URL. Preserve
chat scroll, card context, preview scroll, theme, accessibility labels, Dynamic
Type and text selection. A long title is visually shortened, with its full label
available to assistive technology; file contents are not changed.

Show loading, unavailable daemon, unsupported format, preview limit, forbidden
reference and revoked access as distinct local UI states without exposing secret
paths. Downloads require an explicit tap. Local preview caches are memory-only
and cleared on disconnect; persistent offline saving is a human download action.
Changing daemon connections never accidentally reuses an artifact ID from the
previous daemon. Old clients retain readable path/summary text; new clients on
old daemons show "Preview needs an updated daemon" without a filesystem fallback.

## Verification and implementation slices

Each feature slice adds or updates its own file in `.claude/skills/verify/journeys/`
(or the iOS repo's verify instructions) in its own PR; never edit an index.
Use synthetic workspace/evidence files and a
fresh isolated DB/HOME, never credentials, live user files or port 8399. Leave
repeatable operation/transport checks as scripts. No unattended GUI tests.

Contract and component tests assert visible outcomes: registration receipt,
exact bytes/hash after restart and worktree removal; chunk/download limits;
refused scope/ID guessing; sensitive paths, symlink/hardlink/racing parent swaps;
quota and interrupted captures preserving all data; message/card navigation and
back state; all rendering types, omitted-log counts, relative asset refusals and
disabled scripts. Include adversarial HTML, navigation, network, cookie/storage
and native-bridge attempts made only against synthetic sentinels.

Before calling the viewer shipped, a human drives one recorded web and one iOS
journey: worker registers MD/HTML/image/JSON/log, Neo publishes short references,
taps from conversation and todo card open matching previews, PR/doc links retain
the displayed SHA, large log download matches the original hash, and reopening
after cleanup/restart works from the phone's existing authenticated connection.
Human-guided security checks observe blocked scripts/network/navigation and no
access to synthetic host storage or bridge sentinels. API success or iframe
attributes alone are not proof of browser/WKWebView containment. Capture evidence
paths and label any unverified platform or surface explicitly.

The following are proposed merge contracts, not claims of measured finished
diffs. Target 100–200 production lines each; tests ride their slice. Re-measure
against fresh dev before implementation and split any oversized step before
building. Pin → Build → Wire: introduce no parallel workflow/auth/Markdown
systems. Shared building blocks must remain reachable under knip; a few-line
registration is allowed in its build slice, not premature feature exposure.

| Slice | One PR's scope | Depends on |
| --- | --- | --- |
| 1 Pin | Characterize current chat links, file boundaries and workflow artifact contracts; tests only, zero production lines. | Human design approval |
| 2 Build | Shared artifact refs, result/limit schemas and optional message/card field contracts. | 1 |
| 3 Build | Context-derived roots, sensitive-file denial and caller authorization policy. | 2 |
| 4 Build | Anchored safe-open runtime seam and synthetic race tests; split per OS/runtime if needed. No path-only fallback. | 3 |
| 5 Build | Immutable byte capture, hash, quota reservation and crash-recovery storage shell. | 4 |
| 6 Wire | Registry/migration and `artifact.file.register`, with idempotent receipts. | 5 |
| 7 Wire | Authorized get/list/read operations, bounded chunks and complete-file integrity. | 6 |
| 8 Build | Stored-source reference candidates and deterministic repo/revision resolution rules. | 2, 3 |
| 9 Wire | Human tap resolution to a local file snapshot; missing/ambiguous/revoked cases. | 7, 8 |
| 10 Wire | GitHub PR summary preview using existing read service. | 8 |
| 11 Wire | Bounded PR/repo document capture at immutable SHA. | 7, 10 |
| 12 Wire | Producer artifact references in Neo publications/todo evidence; one-line card guidance. | 6, 2 |
| 13 Build | Web preview shell, Markdown renderer adapter and safe relative-link policy. | 7, 9 |
| 14 Wire | Web message/card taps, PR panel and Back/scroll state. | 10–13 |
| 15 Build | HTML sanitizer, trusted CSP wrapper and inert asset policy. | 7 |
| 16 Wire | Web sandboxed HTML preview and source/disabled-script states. | 14, 15 |
| 17 Wire | Web image/JSON/log previews and streamed full download; split renderers if over budget. | 14, 7 |
| 18 Wire | iOS refs/connection-scoped read client, message/card tap routing and preview sheet. | 7, 9–12 |
| 19 Wire | iOS chat Markdown renderer, safe links and source view. | 18 |
| 20 Wire | Dedicated iOS WKWebView wrapper and deny policies, with human-guided containment proof. | 15, 18 |
| 21 Wire | iOS image/JSON/log previews and explicit complete-file export. | 18 |
| 22 Wire | Optional explicit relative CSS/raster-image bundles; no network crawling or JavaScript. | 7, 15–21 |

Each row is a separately reviewed issue/PR; none authorizes building the next
before its prerequisites merge. API slices prove their actual operation doors;
UI slices need human-guided surface proof, not unattended UI automation. The
first end-to-end Markdown milestone is 1–9 plus 12–14 and 18–19; PR preview,
HTML and other formats follow their listed dependencies. No deletion or
interactive-script execution slice is authorized by this design.
