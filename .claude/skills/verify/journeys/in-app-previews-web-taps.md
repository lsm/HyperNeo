# In-app previews: message paths, legacy cards and Git Back

Use [the A4 live-file web journey](live-file-web-a4.md) for the current browser
proof. Local path taps now read current source content rather than registering a
worktree snapshot. That journey also proves legacy artifact cards and SHA-bound
Git preview/Back on desktop and phone widths, with screenshots and full downloads.

`preview-taps-seed.ts` still supplies the synthetic legacy publication, todo and
artifact fixtures. Its path references are absolute synthetic workspace paths,
so a public Neo reply uses the owning session rather than guessing a todo's
workspace. `preview-taps-web.mjs prepare` retains the shared real-RPC preparation;
its older standalone browser phase predates the file-tab presentations and is
superseded by `live-file-web-a4-proof.mjs`.

Relevant unit suites remain ArtifactPreviewPanel, ArtifactPreviewTabs,
artifact-preview-navigation, artifact-reference-client, MarkdownRenderer.references
and NeoArtifactTaps. New live views are covered by LiveFilePreview and
live-file-client. Do not test with credentials, the live database or port 8399.
