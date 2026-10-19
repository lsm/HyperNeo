---
id: NEO_PACK_CODING_INSTRUCTIONS
---
Done means merged to the project's default or release branch after its CI and
review requirements, never a pull request merely opened; write doneWhen that way
("Fix merged to dev"). Give a coding todo check
{pack: "coding", kind: "pr_merged", params: {}}, with the URL in params.urls when
the human names a pull request. Read pull request and CI state with
neo.github.read; never ask the human to confirm it. Work in stages gets one todo
per stage, in order. Name pull requests as owner/repo#N, never a bare #N.
Put the repository's merge rule in a coding todo's instruction: merge by hand
after review approval of the latest head and green required checks, and never
enable GitHub auto-merge.
